import { Injectable } from '@nestjs/common';
import type { Insertable } from 'kysely';
import { AuditService } from '../../audit';
import { LedgerService } from '../../wallet-ledger';
import { Clock, Money, OutboxService, UnitOfWork, uuidv7 } from '../../../shared-kernel';
import type { ProviderPayment } from '../domain/payment-provider';
import type { IntentRow, PaymentTransactionsTable, PaymentsDb } from '../infrastructure/db-types';

export type PaymentApplyOutcome =
  | 'CREDITED' // money verified, wallet credited
  | 'ALREADY_PROCESSED' // this exact provider payment was handled before: nothing to do
  | 'NOT_FINAL' // authorised but not captured (or otherwise undecided): not money yet, looked at again later
  | 'FAILURE_RECORDED' // a failed attempt, kept for the record; the intent stays open
  | 'IGNORED_STALE_FAILURE' // a "failed" report for a payment we already know was captured: never regress
  | 'QUARANTINED' // captured but does not match the intent: NOT credited, needs a human
  | 'UNKNOWN_ORDER'; // not one of ours

/**
 * Turns a provider payment — already FETCHED SERVER-SIDE from the provider, never taken from a webhook body or a
 * client — into ledger truth. This is the one place a top-up can credit a wallet, and it is the same code path for
 * a webhook, a recovery poll and a customer-triggered verify, which is what makes them interchangeable.
 *
 * Why duplicate / delayed / out-of-order delivery cannot double-credit (critical test #4):
 *   1. the intent row is locked, so concurrent deliveries are processed one at a time;
 *   2. `payment_transactions (provider, provider_payment_id)` is unique, so a payment is recorded once;
 *   3. the ledger posting carries the idempotency key `topup:<provider>:<payment id>`;
 *   4. we act on the provider's CURRENT state, so the order in which events arrive does not matter, and a
 *      "failed" report can never undo a recorded capture.
 */
@Injectable()
export class PaymentSettlementService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  private get db() {
    return this.uow.db<PaymentsDb>();
  }

  async applyPayment(p: ProviderPayment): Promise<PaymentApplyOutcome> {
    return this.uow.run(async () => {
      const intent = await this.db
        .selectFrom('payments.payment_intents')
        .selectAll()
        .where('provider', '=', p.provider)
        .where('provider_order_id', '=', p.orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!intent) return 'UNKNOWN_ORDER';
      if (p.status === 'PENDING') return 'NOT_FINAL'; // nothing is written for a payment that has not been decided

      const existing = await this.db
        .selectFrom('payments.payment_transactions')
        .selectAll()
        .where('provider', '=', p.provider)
        .where('provider_payment_id', '=', p.paymentId)
        .executeTakeFirst();

      if (p.status === 'FAILED') {
        if (existing) return existing.status === 'FAILED' ? 'ALREADY_PROCESSED' : 'IGNORED_STALE_FAILURE';
        await this.db
          .insertInto('payments.payment_transactions')
          .values({
            id: uuidv7(),
            intent_id: intent.id,
            provider: p.provider,
            provider_payment_id: p.paymentId,
            status: 'FAILED',
            amount_minor: p.amountMinor.toString(),
            currency: p.currency,
            ledger_txn_id: null,
            provider_created_at: p.createdAt,
            verified_at: this.clock.now(),
            failure_reason: p.failureReason ?? 'PAYMENT_FAILED',
          })
          .onConflict((oc) => oc.columns(['provider', 'provider_payment_id']).doNothing())
          .execute();
        return 'FAILURE_RECORDED';
      }

      // CAPTURED
      if (existing && existing.status !== 'FAILED') return 'ALREADY_PROCESSED';
      return this.settleCapture(intent, p, existing?.id);
    });
  }

  private async settleCapture(intent: IntentRow, p: ProviderPayment, existingFailedRowId: string | undefined): Promise<PaymentApplyOutcome> {
    const now = this.clock.now();
    const txId = existingFailedRowId ?? uuidv7();
    const matches = p.amountMinor === BigInt(intent.amount_minor) && p.currency === intent.currency;

    if (!matches) {
      // The provider took a different amount than we asked for. Crediting either figure would be a guess about
      // money, so credit nothing and make it loud. Resolution is a human decision (refund at the provider or adjust).
      const reason = `AMOUNT_MISMATCH: expected ${intent.amount_minor} ${intent.currency}, provider captured ${p.amountMinor} ${p.currency}`;
      await this.writeTransaction(existingFailedRowId, {
        id: txId,
        intent_id: intent.id,
        provider: p.provider,
        provider_payment_id: p.paymentId,
        status: 'QUARANTINED',
        amount_minor: p.amountMinor.toString(),
        currency: p.currency,
        ledger_txn_id: null,
        provider_created_at: p.createdAt,
        verified_at: now,
        failure_reason: reason,
      });
      await this.audit.record({
        actorType: 'SYSTEM',
        action: 'payment.quarantined',
        entityType: 'payment_transaction',
        entityId: txId,
        after: { intent_id: intent.id, expected_minor: intent.amount_minor, captured_minor: p.amountMinor, currency: p.currency },
      });
      await this.outbox.publish({ type: 'payments.payment_quarantined', aggregateType: 'payment_transaction', aggregateId: txId, payload: { payment_transaction_id: txId, intent_id: intent.id } });
      return 'QUARANTINED';
    }

    const credit = await this.ledger.creditVerifiedPayment({
      customerId: intent.customer_id,
      amount: Money.of(p.amountMinor, p.currency),
      paymentRef: txId,
      idempotencyKey: `topup:${p.provider}:${p.paymentId}`,
      actor: { type: 'SYSTEM' },
    });
    await this.writeTransaction(existingFailedRowId, {
      id: txId,
      intent_id: intent.id,
      provider: p.provider,
      provider_payment_id: p.paymentId,
      status: 'CAPTURED',
      amount_minor: p.amountMinor.toString(),
      currency: p.currency,
      ledger_txn_id: credit.txnId,
      provider_created_at: p.createdAt,
      verified_at: now,
      failure_reason: null,
    });

    const wasOpen = intent.status === 'PENDING';
    if (intent.status !== 'SUCCEEDED') {
      await this.db.updateTable('payments.payment_intents').set({ status: 'SUCCEEDED', succeeded_at: now, updated_at: now }).where('id', '=', intent.id).execute();
    }
    await this.audit.record({
      actorType: 'SYSTEM',
      // A capture on an intent that already succeeded means the customer was charged twice; on an expired one it means
      // the callback was very late. Both are credited (the book follows reality) and both are flagged for follow-up.
      action: intent.status === 'SUCCEEDED' ? 'payment.duplicate_capture_credited' : wasOpen ? 'payment.captured' : 'payment.late_capture_credited',
      entityType: 'payment_transaction',
      entityId: txId,
      after: { intent_id: intent.id, amount_minor: p.amountMinor, currency: p.currency, provider: p.provider, intent_status_before: intent.status },
    });
    await this.outbox.publish({
      type: 'payments.topup_succeeded',
      aggregateType: 'payment_intent',
      aggregateId: intent.id,
      payload: { intent_id: intent.id, customer_id: intent.customer_id, payment_transaction_id: txId, amount_minor: Number(p.amountMinor), currency: p.currency },
    });
    return 'CREDITED';
  }

  /** Inserts a new payment row, or upgrades the FAILED row this payment id previously produced. */
  private async writeTransaction(existingId: string | undefined, row: Insertable<PaymentTransactionsTable>): Promise<void> {
    if (!existingId) {
      await this.db.insertInto('payments.payment_transactions').values(row).execute();
      return;
    }
    const { id: _id, intent_id: _intent, provider: _provider, provider_payment_id: _pid, ...changes } = row;
    await this.db.updateTable('payments.payment_transactions').set(changes).where('id', '=', existingId).execute();
  }
}
