import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit';
import { Clock, DomainError, Money, NotFoundError, UnitOfWork, uuidv7 } from '../../../shared-kernel';
import { PaymentProvider } from '../domain/payment-provider';
import type { PaymentsDb, ReconciliationStatus } from '../infrastructure/db-types';

const MAX_SPAN_MS = 31 * 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReconciliationException {
  status: Exclude<ReconciliationStatus, 'MATCHED'>;
  provider_payment_id: string | null;
  payment_transaction_id: string | null;
  expected: { amount_minor: number; currency: string } | null;
  actual: { amount_minor: number; currency: string } | null;
  detail: string;
}

export interface ReconciliationResult {
  id: string;
  provider: string;
  period_from: string;
  period_to: string;
  matched: number;
  exceptions: number;
  records: ReconciliationException[];
}

/**
 * Compares OUR record of captured payments with the PROVIDER'S for a period, both keyed on the provider's own payment
 * id and the provider's own timestamp (so a payment on the edge of the window cannot appear on only one side).
 * It reports; it never repairs — every exception is a question for a human with the provider's dashboard.
 *
 *   MISSING_INTERNAL  the provider took money we have no record of        <- the dangerous one
 *   MISSING_EXTERNAL  we recorded a capture the provider does not show
 *   AMOUNT_MISMATCH   both exist but disagree (includes quarantined payments, which were never credited)
 *   REFUND_MISMATCH   the provider shows MORE refunded than we ever asked for: a refund made outside our system
 *                     (e.g. in the provider's dashboard) — money left, and the customer's wallet was never reduced
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly provider: PaymentProvider,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.uow.db<PaymentsDb>();
  }

  async run(input: { from: Date; to: Date; startedBy: string | null }): Promise<ReconciliationResult> {
    const { from, to } = input;
    if (!(from.getTime() < to.getTime())) throw new DomainError('INVALID_PERIOD', 'The period must end after it starts', 422);
    if (to.getTime() - from.getTime() > MAX_SPAN_MS) throw new DomainError('PERIOD_TOO_LONG', 'Reconcile at most 31 days at a time', 422);

    const external = (await this.provider.listPayments({ from, to })).filter((p) => p.status === 'CAPTURED');
    const internal = await this.db
      .selectFrom('payments.payment_transactions as t')
      .innerJoin('payments.payment_intents as i', 'i.id', 't.intent_id')
      .select(['t.id', 't.provider_payment_id', 't.status', 't.amount_minor', 't.currency', 'i.amount_minor as intent_amount_minor'])
      .where('t.provider', '=', this.provider.name)
      .where('t.provider_created_at', '>=', from)
      .where('t.provider_created_at', '<', to)
      .where('t.status', 'in', ['CAPTURED', 'QUARANTINED'])
      .execute();

    // What we have asked the provider to refund per payment (everything not known to have failed, including requests still in flight).
    const requested = new Map(
      (
        await this.db
          .selectFrom('payments.refunds')
          .select(['payment_transaction_id', (eb) => eb.fn.sum<string>('amount_minor').as('total')])
          .where('payment_transaction_id', 'in', internal.length ? internal.map((t) => t.id) : [uuidv7()])
          .where('status', '<>', 'FAILED')
          .groupBy('payment_transaction_id')
          .execute()
      ).map((r) => [r.payment_transaction_id, BigInt(r.total)]),
    );
    const money = (minor: bigint, currency: string) => Money.of(minor, currency).toJSON();
    const byId = new Map(internal.map((t) => [t.provider_payment_id, t]));
    const seen = new Set<string>();
    const exceptions: ReconciliationException[] = [];
    let matched = 0;

    for (const p of external) {
      seen.add(p.paymentId);
      const t = byId.get(p.paymentId);
      if (!t) {
        exceptions.push({ status: 'MISSING_INTERNAL', provider_payment_id: p.paymentId, payment_transaction_id: null, expected: null, actual: money(p.amountMinor, p.currency), detail: 'The provider captured this payment but we have no record of it' });
      } else if (t.status === 'QUARANTINED') {
        exceptions.push({ status: 'AMOUNT_MISMATCH', provider_payment_id: p.paymentId, payment_transaction_id: t.id, expected: money(BigInt(t.intent_amount_minor), t.currency), actual: money(p.amountMinor, p.currency), detail: 'Captured but quarantined, not credited: the amount does not match the payment request' });
      } else if (BigInt(t.amount_minor) !== p.amountMinor || t.currency !== p.currency) {
        exceptions.push({ status: 'AMOUNT_MISMATCH', provider_payment_id: p.paymentId, payment_transaction_id: t.id, expected: money(BigInt(t.amount_minor), t.currency), actual: money(p.amountMinor, p.currency), detail: 'Our recorded amount differs from the provider\'s' });
      } else if (p.amountRefundedMinor > (requested.get(t.id) ?? 0n)) {
        exceptions.push({ status: 'REFUND_MISMATCH', provider_payment_id: p.paymentId, payment_transaction_id: t.id, expected: money(requested.get(t.id) ?? 0n, t.currency), actual: money(p.amountRefundedMinor, p.currency), detail: 'The provider shows more refunded than we requested — a refund made outside this system' });
      } else {
        matched += 1;
      }
    }
    for (const t of internal) {
      if (t.status === 'CAPTURED' && !seen.has(t.provider_payment_id)) {
        exceptions.push({ status: 'MISSING_EXTERNAL', provider_payment_id: t.provider_payment_id, payment_transaction_id: t.id, expected: money(BigInt(t.amount_minor), t.currency), actual: null, detail: 'We recorded this capture but the provider does not list it for this period' });
      }
    }

    return this.uow.run(async () => {
      const now = this.clock.now();
      const runId = uuidv7();
      await this.db.insertInto('payments.reconciliation_runs').values({ id: runId, provider: this.provider.name, period_from: from, period_to: to, started_by: input.startedBy, matched, exceptions: exceptions.length, created_at: now }).execute();
      // Only exceptions are stored; matches are summarised by the count (a month of matches is noise, not evidence).
      for (const e of exceptions) {
        await this.db
          .insertInto('payments.reconciliation_records')
          .values({
            id: uuidv7(),
            run_id: runId,
            status: e.status,
            external_ref: e.provider_payment_id,
            internal_ref: e.payment_transaction_id,
            expected_minor: e.expected ? String(e.expected.amount_minor) : null,
            actual_minor: e.actual ? String(e.actual.amount_minor) : null,
            detail: e.detail,
            created_at: now,
          })
          .execute();
      }
      await this.audit.record({
        actorType: input.startedBy ? 'USER' : 'SYSTEM',
        actorId: input.startedBy,
        action: 'payments.reconciliation_run',
        entityType: 'reconciliation_run',
        entityId: runId,
        after: { provider: this.provider.name, matched, exceptions: exceptions.length },
      });
      return { id: runId, provider: this.provider.name, period_from: from.toISOString(), period_to: to.toISOString(), matched, exceptions: exceptions.length, records: exceptions };
    });
  }

  async get(runId: string): Promise<ReconciliationResult> {
    if (!UUID_RE.test(runId)) throw new NotFoundError('Reconciliation run');
    const run = await this.db.selectFrom('payments.reconciliation_runs').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!run) throw new NotFoundError('Reconciliation run');
    const rows = await this.db.selectFrom('payments.reconciliation_records').selectAll().where('run_id', '=', runId).orderBy('id').execute();
    return {
      id: run.id,
      provider: run.provider,
      period_from: run.period_from.toISOString(),
      period_to: run.period_to.toISOString(),
      matched: run.matched,
      exceptions: run.exceptions,
      records: rows.map((r) => ({
        status: r.status as ReconciliationException['status'],
        provider_payment_id: r.external_ref,
        payment_transaction_id: r.internal_ref,
        expected: r.expected_minor === null ? null : Money.of(BigInt(r.expected_minor), 'INR').toJSON(),
        actual: r.actual_minor === null ? null : Money.of(BigInt(r.actual_minor), 'INR').toJSON(),
        detail: r.detail ?? '',
      })),
    };
  }
}
