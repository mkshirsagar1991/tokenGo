import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit';
import { Clock, DomainError, Money, NotFoundError, UnitOfWork, uuidv7 } from '../../../shared-kernel';
import { PayoutProvider, ProviderPayout } from '../domain/payout-provider';
import type { PayoutStatus, SettlementDb, SettlementReconStatus } from '../infrastructure/db-types';

const MAX_SPAN_MS = 31 * 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PayoutReconciliationException {
  status: Exclude<SettlementReconStatus, 'MATCHED'>;
  reference: string | null;
  payout_id: string | null;
  expected: { amount_minor: number; currency: string } | null;
  actual: { amount_minor: number; currency: string } | null;
  detail: string;
}

export interface PayoutReconciliationResult {
  id: string;
  provider: string;
  period_from: string;
  period_to: string;
  matched: number;
  exceptions: number;
  records: PayoutReconciliationException[];
}

/** Which provider states agree with which of our states. Anything else is an exception a human must look at. */
const AGREES: Record<PayoutStatus, ReadonlySet<ProviderPayout['status']>> = {
  RESERVED: new Set(['QUEUED', 'PROCESSING']),
  SUBMITTED: new Set(['QUEUED', 'PROCESSING']),
  PAID: new Set(['PAID']),
  FAILED: new Set(['FAILED', 'REVERSED']),
};

/**
 * Compares OUR payouts with the PAYOUT PROVIDER'S for a period, keyed on our reference (the payout id) and on the provider's own
 * timestamp. It reports; it never repairs.
 *   MISSING_INTERNAL  the provider has a payout we have no record of     <- money may have left for a transfer we did not make
 *   MISSING_EXTERNAL  we believe the provider has it and it does not
 *   AMOUNT_MISMATCH   same reference, different amount
 *   STATUS_MISMATCH   e.g. we say FAILED and the provider says PAID (a double payment waiting to happen)
 */
@Injectable()
export class PayoutReconciliationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly provider: PayoutProvider,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.uow.db<SettlementDb>();
  }

  async run(input: { from: Date; to: Date; startedBy: string | null }): Promise<PayoutReconciliationResult> {
    const { from, to } = input;
    if (!(from.getTime() < to.getTime())) throw new DomainError('INVALID_PERIOD', 'The period must end after it starts', 422);
    if (to.getTime() - from.getTime() > MAX_SPAN_MS) throw new DomainError('PERIOD_TOO_LONG', 'Reconcile at most 31 days at a time', 422);

    const external = await this.provider.listPayouts({ from, to });
    const internal = await this.db
      .selectFrom('settlement.payouts')
      .select(['id', 'amount_minor', 'currency', 'status', 'provider_reference', 'provider_payout_id'])
      .where('provider_name', '=', this.provider.name)
      .where('provider_payout_id', 'is not', null)
      .where('provider_created_at', '>=', from)
      .where('provider_created_at', '<', to)
      .execute();

    const money = (minor: bigint, currency: string) => Money.of(minor, currency).toJSON();
    const byRef = new Map(internal.map((p) => [p.provider_reference, p]));
    const seen = new Set<string>();
    const exceptions: PayoutReconciliationException[] = [];
    let matched = 0;

    for (const e of external) {
      seen.add(e.reference);
      const p = byRef.get(e.reference);
      if (!p) {
        exceptions.push({ status: 'MISSING_INTERNAL', reference: e.reference, payout_id: null, expected: null, actual: money(e.amountMinor, e.currency), detail: 'The payout provider has a payout we have no record of' });
      } else if (BigInt(p.amount_minor) !== e.amountMinor || p.currency !== e.currency) {
        exceptions.push({ status: 'AMOUNT_MISMATCH', reference: e.reference, payout_id: p.id, expected: money(BigInt(p.amount_minor), p.currency), actual: money(e.amountMinor, e.currency), detail: 'Our payout amount differs from the provider\'s' });
      } else if (!AGREES[p.status].has(e.status)) {
        exceptions.push({ status: 'STATUS_MISMATCH', reference: e.reference, payout_id: p.id, expected: money(BigInt(p.amount_minor), p.currency), actual: money(e.amountMinor, e.currency), detail: `We say ${p.status}; the provider says ${e.status}` });
      } else {
        matched += 1;
      }
    }
    for (const p of internal) {
      if (!seen.has(p.provider_reference)) {
        exceptions.push({ status: 'MISSING_EXTERNAL', reference: p.provider_reference, payout_id: p.id, expected: money(BigInt(p.amount_minor), p.currency), actual: null, detail: 'We recorded this payout at the provider but it does not list it for this period' });
      }
    }

    return this.uow.run(async () => {
      const now = this.clock.now();
      const runId = uuidv7();
      await this.db.insertInto('settlement.reconciliation_runs').values({ id: runId, provider_name: this.provider.name, period_from: from, period_to: to, started_by: input.startedBy, matched, exceptions: exceptions.length, created_at: now }).execute();
      for (const e of exceptions) {
        await this.db
          .insertInto('settlement.reconciliation_records')
          .values({ id: uuidv7(), run_id: runId, status: e.status, external_ref: e.reference, internal_ref: e.payout_id, expected_minor: e.expected ? String(e.expected.amount_minor) : null, actual_minor: e.actual ? String(e.actual.amount_minor) : null, detail: e.detail, created_at: now })
          .execute();
      }
      await this.audit.record({ actorType: input.startedBy ? 'USER' : 'SYSTEM', actorId: input.startedBy, action: 'payouts.reconciliation_run', entityType: 'reconciliation_run', entityId: runId, after: { provider: this.provider.name, matched, exceptions: exceptions.length } });
      return { id: runId, provider: this.provider.name, period_from: from.toISOString(), period_to: to.toISOString(), matched, exceptions: exceptions.length, records: exceptions };
    });
  }

  async get(runId: string): Promise<PayoutReconciliationResult> {
    if (!UUID_RE.test(runId)) throw new NotFoundError('Reconciliation run');
    const run = await this.db.selectFrom('settlement.reconciliation_runs').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!run) throw new NotFoundError('Reconciliation run');
    const rows = await this.db.selectFrom('settlement.reconciliation_records').selectAll().where('run_id', '=', runId).orderBy('id').execute();
    return {
      id: run.id,
      provider: run.provider_name,
      period_from: run.period_from.toISOString(),
      period_to: run.period_to.toISOString(),
      matched: run.matched,
      exceptions: run.exceptions,
      records: rows.map((r) => ({
        status: r.status as PayoutReconciliationException['status'],
        reference: r.external_ref,
        payout_id: r.internal_ref,
        expected: r.expected_minor === null ? null : Money.of(BigInt(r.expected_minor), 'INR').toJSON(),
        actual: r.actual_minor === null ? null : Money.of(BigInt(r.actual_minor), 'INR').toJSON(),
        detail: r.detail ?? '',
      })),
    };
  }
}
