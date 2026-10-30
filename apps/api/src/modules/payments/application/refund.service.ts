import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit';
import { InsufficientFundsError, LedgerService } from '../../wallet-ledger';
import { Clock, ConflictError, DomainError, Money, NotFoundError, OutboxService, UnitOfWork, uuidv7 } from '../../../shared-kernel';
import { PaymentProvider, ProviderRefund, ProviderRejectedError } from '../domain/payment-provider';
import type { PaymentsDb, RefundRow, RefundStatus } from '../infrastructure/db-types';

export interface RefundView {
  id: string;
  payment_transaction_id: string;
  amount: { amount_minor: number; currency: string };
  status: RefundStatus;
  reason: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type RefundApplyOutcome = 'COMPLETED' | 'ABORTED' | 'PENDING' | 'ALREADY_FINAL' | 'UNKNOWN_REFUND';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM = { type: 'SYSTEM' } as const;

/**
 * Refunds a captured top-up back to the ORIGINAL payment instrument (requirements §14).
 *
 * Money moves in two ledger steps so that a slow or failing provider can never leave the books wrong:
 *   request  DR customer_available / CR refund_clearing   (money leaves the wallet at once; it cannot be double-spent)
 *   success  DR refund_clearing     / CR gateway_clearing  (the provider confirmed the payout)
 *   failure  a COMPENSATING reversal of the request        (the customer gets the money back)
 * The call to the provider is made by an outbox consumer AFTER the request commits, with our refund id as the
 * provider-side idempotency key — so a crash or retry can never refund twice (query-before-retry, critical test #7).
 */
@Injectable()
export class RefundService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly provider: PaymentProvider,
  ) {}

  private get db() {
    return this.uow.db<PaymentsDb>();
  }

  async create(input: { paymentTransactionId: string; amountMinor?: number; reason: string; idempotencyKey: string; actorId: string }): Promise<RefundView> {
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500) throw new DomainError('INVALID_REASON', 'A reason of 3-500 characters is required', 422);
    if (input.amountMinor !== undefined && !Number.isSafeInteger(input.amountMinor)) throw new DomainError('INVALID_AMOUNT', 'The amount must be a whole number of paise', 422);

    return this.uow.run(async () => {
      const replay = await this.db.selectFrom('payments.refunds').selectAll().where('requested_by', '=', input.actorId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) return this.toView(replay);

      // Lock the payment: two refunds of the same payment are decided one at a time, so the refundable total is exact.
      const tx = await this.db.selectFrom('payments.payment_transactions').selectAll().where('id', '=', input.paymentTransactionId).forUpdate().executeTakeFirst();
      if (!tx) throw new NotFoundError('Payment');
      if (tx.status !== 'CAPTURED') throw new ConflictError('PAYMENT_NOT_REFUNDABLE', 'Only a captured payment can be refunded');
      const intent = await this.db.selectFrom('payments.payment_intents').select('customer_id').where('id', '=', tx.intent_id).executeTakeFirstOrThrow();

      const refunded = await this.db
        .selectFrom('payments.refunds')
        .select((eb) => eb.fn.sum<string>('amount_minor').as('total'))
        .where('payment_transaction_id', '=', tx.id)
        .where('status', '<>', 'FAILED')
        .executeTakeFirst();
      const refundable = BigInt(tx.amount_minor) - BigInt(refunded?.total ?? '0');
      const amount = input.amountMinor === undefined ? refundable : BigInt(input.amountMinor);
      if (amount <= 0n || amount > refundable) {
        throw new DomainError('REFUND_EXCEEDS_PAYMENT', 'The refund is more than what remains refundable on this payment', 422, { refundable: Money.of(refundable, tx.currency).toJSON() });
      }

      const id = uuidv7();
      await this.db
        .insertInto('payments.refunds')
        .values({
          id,
          payment_transaction_id: tx.id,
          customer_id: intent.customer_id,
          amount_minor: amount.toString(),
          currency: tx.currency,
          provider: tx.provider,
          provider_refund_id: null,
          reason,
          requested_by: input.actorId,
          idempotency_key: input.idempotencyKey,
          reserve_txn_id: null,
          close_txn_id: null,
          failure_reason: null,
          created_at: this.clock.now(),
        })
        .execute();

      let reserveTxnId: string;
      try {
        ({ txnId: reserveTxnId } = await this.ledger.reserveRefund({
          customerId: intent.customer_id,
          amount: Money.of(amount, tx.currency),
          refundId: id,
          idempotencyKey: `refund-reserve:${id}`,
          actor: { type: 'USER', id: input.actorId },
        }));
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          // Rolls the refund row back with it: nothing was refunded and nothing was promised.
          throw new ConflictError('REFUND_FUNDS_ALREADY_SPENT', 'The customer has already spent this money, so it can no longer be refunded to the original payment method', err.details);
        }
        throw err;
      }
      await this.db.updateTable('payments.refunds').set({ reserve_txn_id: reserveTxnId }).where('id', '=', id).execute();
      await this.audit.record({
        actorType: 'USER',
        actorId: input.actorId,
        action: 'refund.requested',
        entityType: 'refund',
        entityId: id,
        after: { payment_transaction_id: tx.id, amount_minor: amount, currency: tx.currency, reason },
      });
      // The provider call happens in a consumer AFTER this commits — never inside a transaction that could roll back
      // after the money has already been sent.
      await this.outbox.publish({ type: 'payments.refund_requested', aggregateType: 'refund', aggregateId: id, payload: { refund_id: id } });
      return this.toView(await this.db.selectFrom('payments.refunds').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
    });
  }

  async get(refundId: string): Promise<RefundView> {
    if (!UUID_RE.test(refundId)) throw new NotFoundError('Refund');
    const row = await this.db.selectFrom('payments.refunds').selectAll().where('id', '=', refundId).executeTakeFirst();
    if (!row) throw new NotFoundError('Refund');
    return this.toView(row);
  }

  async list(opts: { status?: RefundStatus; paymentTransactionId?: string; limit: number; cursor?: string }): Promise<{ data: RefundView[]; nextCursor: string | null }> {
    let q = this.db.selectFrom('payments.refunds').selectAll().orderBy('id', 'desc').limit(opts.limit + 1);
    if (opts.status) q = q.where('status', '=', opts.status);
    if (opts.paymentTransactionId) q = q.where('payment_transaction_id', '=', opts.paymentTransactionId);
    if (opts.cursor) q = q.where('id', '<', opts.cursor);
    const rows = await q.execute();
    const page = rows.slice(0, opts.limit);
    return { data: page.map((r) => this.toView(r)), nextCursor: rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  /**
   * Sends a PROCESSING refund to the provider and records the outcome. Idempotent and safe to run any number of
   * times, from the outbox consumer or the recovery sweeper: it asks the provider first when a refund id is
   * already known, and otherwise relies on the provider-side idempotency key (our refund id).
   */
  async submit(refundId: string): Promise<void> {
    const r = await this.db
      .selectFrom('payments.refunds as r')
      .innerJoin('payments.payment_transactions as t', 't.id', 'r.payment_transaction_id')
      .select(['r.id', 'r.status', 'r.amount_minor', 'r.provider_refund_id', 't.provider_payment_id'])
      .where('r.id', '=', refundId)
      .executeTakeFirst();
    if (!r || r.status !== 'PROCESSING') return;

    let providerRefund: ProviderRefund | null;
    if (r.provider_refund_id) {
      // A STATUS QUERY. Whatever it answers, it can never be a reason to return the customer's money: the refund already exists
      // at the provider, so a failed or odd lookup is retried, not acted on.
      providerRefund = await this.provider.fetchRefund(r.provider_refund_id);
    } else {
      try {
        providerRefund = await this.provider.createRefund({ paymentId: r.provider_payment_id, amountMinor: BigInt(r.amount_minor), idempotencyKey: r.id });
      } catch (err) {
        // A DEFINITIVE refusal of the create call (not a network error): the refund cannot happen, so give the customer their money back.
        if (err instanceof ProviderRejectedError) {
          await this.abort(r.id, `REJECTED_BY_PROVIDER: ${err.code}`);
          return;
        }
        throw err; // transient: the outbox retries with backoff, the provider-side key prevents a second refund
      }
    }
    if (!providerRefund) throw new Error('The provider does not know this refund yet; retrying');
    await this.applyProviderRefund(providerRefund);
  }

  /** Applies the provider's current view of a refund (from submit, a webhook or a poll) to the books. */
  async applyProviderRefund(pr: ProviderRefund): Promise<RefundApplyOutcome> {
    if (!UUID_RE.test(pr.reference)) return 'UNKNOWN_REFUND';
    return this.uow.run(async () => {
      const r = await this.db.selectFrom('payments.refunds').selectAll().where('id', '=', pr.reference).forUpdate().executeTakeFirst();
      if (!r || r.provider !== pr.provider) return 'UNKNOWN_REFUND';
      if (r.status !== 'PROCESSING') return 'ALREADY_FINAL';
      if (BigInt(r.amount_minor) !== pr.amountMinor) throw new Error(`Refund ${r.id}: provider amount ${pr.amountMinor} differs from ${r.amount_minor}`);
      if (!r.provider_refund_id) await this.db.updateTable('payments.refunds').set({ provider_refund_id: pr.refundId }).where('id', '=', r.id).execute();

      if (pr.status === 'PENDING') return 'PENDING';
      if (pr.status === 'FAILED') return this.abortLocked(r, 'FAILED_AT_PROVIDER');

      const close = await this.ledger.completeRefund({ refundId: r.id, amount: Money.of(BigInt(r.amount_minor), r.currency), idempotencyKey: `refund-complete:${r.id}`, actor: SYSTEM });
      await this.db.updateTable('payments.refunds').set({ status: 'SUCCEEDED', close_txn_id: close.txnId, updated_at: this.clock.now() }).where('id', '=', r.id).execute();
      await this.audit.record({ actorType: 'SYSTEM', action: 'refund.succeeded', entityType: 'refund', entityId: r.id, after: { amount_minor: r.amount_minor, currency: r.currency } });
      await this.outbox.publish({ type: 'payments.refund_succeeded', aggregateType: 'refund', aggregateId: r.id, payload: { refund_id: r.id, customer_id: r.customer_id, amount_minor: Number(r.amount_minor), currency: r.currency } });
      return 'COMPLETED';
    });
  }

  private async abort(refundId: string, failureReason: string): Promise<void> {
    await this.uow.run(async () => {
      const r = await this.db.selectFrom('payments.refunds').selectAll().where('id', '=', refundId).forUpdate().executeTakeFirst();
      if (r && r.status === 'PROCESSING') await this.abortLocked(r, failureReason);
    });
  }

  /** Compensates the reservation (the customer is made whole) and closes the refund as FAILED. Caller holds the row lock. */
  private async abortLocked(r: RefundRow, failureReason: string): Promise<RefundApplyOutcome> {
    if (!r.reserve_txn_id) throw new Error(`Refund ${r.id} has no reservation to compensate`);
    const back = await this.ledger.abortRefund({ reserveTxnId: r.reserve_txn_id, reason: failureReason, idempotencyKey: `refund-abort:${r.id}`, actor: SYSTEM });
    await this.db.updateTable('payments.refunds').set({ status: 'FAILED', failure_reason: failureReason.slice(0, 300), close_txn_id: back.txnId, updated_at: this.clock.now() }).where('id', '=', r.id).execute();
    await this.audit.record({ actorType: 'SYSTEM', action: 'refund.failed', entityType: 'refund', entityId: r.id, after: { reason: failureReason } });
    await this.outbox.publish({ type: 'payments.refund_failed', aggregateType: 'refund', aggregateId: r.id, payload: { refund_id: r.id, customer_id: r.customer_id } });
    return 'ABORTED';
  }

  private toView(r: RefundRow): RefundView {
    return {
      id: r.id,
      payment_transaction_id: r.payment_transaction_id,
      amount: Money.of(BigInt(r.amount_minor), r.currency).toJSON(),
      status: r.status,
      reason: r.reason,
      failure_reason: r.failure_reason,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    };
  }
}
