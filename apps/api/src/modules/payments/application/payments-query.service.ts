import { Injectable } from '@nestjs/common';
import { Money, UnitOfWork } from '../../../shared-kernel';
import type { PaymentTxStatus, PaymentsDb, WebhookStatus } from '../infrastructure/db-types';

/** Read-side for finance/support: what was paid, and what the provider told us. No payloads, no PII — ids only. */
@Injectable()
export class PaymentsQueryService {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.db<PaymentsDb>();
  }

  async listTransactions(opts: { status?: PaymentTxStatus; customerId?: string; limit: number; cursor?: string }) {
    let q = this.db
      .selectFrom('payments.payment_transactions as t')
      .innerJoin('payments.payment_intents as i', 'i.id', 't.intent_id')
      .select(['t.id', 't.intent_id', 'i.customer_id', 't.provider', 't.provider_payment_id', 't.status', 't.amount_minor', 't.currency', 't.failure_reason', 't.ledger_txn_id', 't.created_at'])
      .orderBy('t.id', 'desc')
      .limit(opts.limit + 1);
    if (opts.status) q = q.where('t.status', '=', opts.status);
    if (opts.customerId) q = q.where('i.customer_id', '=', opts.customerId);
    if (opts.cursor) q = q.where('t.id', '<', opts.cursor);
    const rows = await q.execute();
    const page = rows.slice(0, opts.limit);
    return {
      data: page.map((r) => ({
        id: r.id,
        intent_id: r.intent_id,
        customer_id: r.customer_id,
        provider: r.provider,
        provider_payment_id: r.provider_payment_id,
        status: r.status,
        amount: Money.of(BigInt(r.amount_minor), r.currency).toJSON(),
        failure_reason: r.failure_reason,
        ledger_txn_id: r.ledger_txn_id,
        created_at: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async listWebhookEvents(opts: { status?: WebhookStatus; limit: number; cursor?: string }) {
    let q = this.db
      .selectFrom('payments.webhook_events')
      .select(['id', 'provider', 'provider_event_id', 'event_type', 'signature_valid', 'processing_status', 'outcome', 'attempts', 'last_error', 'received_at', 'processed_at'])
      .orderBy('id', 'desc')
      .limit(opts.limit + 1);
    if (opts.status) q = q.where('processing_status', '=', opts.status);
    if (opts.cursor) q = q.where('id', '<', opts.cursor);
    const rows = await q.execute();
    const page = rows.slice(0, opts.limit);
    return {
      data: page.map((r) => ({
        id: r.id,
        provider: r.provider,
        provider_event_id: r.provider_event_id,
        event_type: r.event_type,
        signature_valid: r.signature_valid,
        status: r.processing_status,
        outcome: r.outcome,
        attempts: r.attempts,
        last_error: r.last_error,
        received_at: r.received_at.toISOString(),
        processed_at: r.processed_at ? r.processed_at.toISOString() : null,
      })),
      nextCursor: rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
