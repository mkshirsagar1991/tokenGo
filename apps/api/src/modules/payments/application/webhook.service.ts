import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock, DomainError, NotFoundError, UnauthenticatedError, UnitOfWork, ValidationFailedError, uuidv7 } from '../../../shared-kernel';
import { PaymentProvider, WebhookEnvelope, WebhookSignatureError } from '../domain/payment-provider';
import type { PaymentsDb } from '../infrastructure/db-types';
import { PaymentSettlementService } from './payment-settlement.service';
import { RefundService } from './refund.service';

export type WebhookResult = 'processed' | 'duplicate' | 'ignored';

/** An event stuck in RECEIVED this long is assumed to belong to a crashed attempt and is processed again. */
const STUCK_AFTER_MS = 30_000;

/**
 * Receives provider callbacks. The rules, in order:
 *   1. AUTHENTICATE over the raw bytes. A bad signature is recorded (without trusting a single field of it) and refused.
 *   2. PERSIST before acting, so every authentic event is auditable and replayable.
 *   3. DEDUPLICATE on the provider's event id — but correctness never depends on it: processing is idempotent on its own.
 *   4. NEVER TRUST THE BODY. The event only says "go look at payment X"; the amount and status come from a
 *      server-to-server fetch from the provider.
 * Answers: 2xx = stop sending it (processed / duplicate / ignored); 4xx = not ours / not authentic;
 * 503 = our fault, please retry (the recovery job settles the payment independently in any case).
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly provider: PaymentProvider,
    private readonly settlement: PaymentSettlementService,
    private readonly refunds: RefundService,
  ) {}

  private get db() {
    return this.uow.db<PaymentsDb>();
  }

  async receive(providerName: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>): Promise<WebhookResult> {
    if (providerName !== this.provider.name) throw new NotFoundError('Webhook endpoint');
    if (!rawBody || rawBody.length === 0) throw new ValidationFailedError('The request body is required');

    let envelope: WebhookEnvelope;
    try {
      envelope = this.provider.verifyWebhook(rawBody, headers);
    } catch (err) {
      if (!(err instanceof WebhookSignatureError)) throw err;
      // Kept for visibility into abuse, but with NOTHING from the request: no event id, no payload.
      await this.db
        .insertInto('payments.webhook_events')
        .values({ id: uuidv7(), provider: providerName, provider_event_id: null, event_type: null, signature_valid: false, payload: null, processing_status: 'REJECTED', outcome: null, last_error: err.reason, received_at: this.clock.now(), processed_at: null })
        .execute();
      throw new UnauthenticatedError('The webhook signature is not valid', 'WEBHOOK_SIGNATURE_INVALID');
    }

    const now = this.clock.now();
    const inserted = await this.db
      .insertInto('payments.webhook_events')
      .values({ id: uuidv7(), provider: providerName, provider_event_id: envelope.eventId, event_type: envelope.type, signature_valid: true, payload: JSON.stringify(envelope.data), processing_status: 'RECEIVED', outcome: null, last_error: null, received_at: now, processed_at: null })
      .onConflict((oc) => oc.columns(['provider', 'provider_event_id']).doNothing())
      .returning('id')
      .executeTakeFirst();

    let eventId: string;
    if (inserted) {
      eventId = inserted.id;
    } else {
      const prior = await this.db.selectFrom('payments.webhook_events').selectAll().where('provider', '=', providerName).where('provider_event_id', '=', envelope.eventId).executeTakeFirstOrThrow();
      const retryable = prior.processing_status === 'FAILED' || (prior.processing_status === 'RECEIVED' && now.getTime() - prior.received_at.getTime() > STUCK_AFTER_MS);
      if (!retryable) return 'duplicate';
      eventId = prior.id;
    }

    try {
      return await this.process(eventId, envelope);
    } catch (err) {
      await this.db
        .updateTable('payments.webhook_events')
        .set({ processing_status: 'FAILED', attempts: sql<number>`attempts + 1`, last_error: (err instanceof Error ? err.message : String(err)).slice(0, 500) })
        .where('id', '=', eventId)
        .execute();
      throw new DomainError('WEBHOOK_PROCESSING_FAILED', 'The event could not be processed right now; please redeliver it', 503);
    }
  }

  private async process(eventId: string, envelope: WebhookEnvelope): Promise<WebhookResult> {
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);

    switch (envelope.type) {
      case 'payment.captured':
      case 'payment.failed': {
        const paymentId = str(envelope.data['payment_id']);
        if (!paymentId) return this.close(eventId, 'IGNORED', 'missing payment_id');
        const payment = await this.provider.fetchPayment(paymentId); // the source of truth, not the webhook body
        if (!payment) throw new Error('the provider does not know this payment (yet)');
        return this.uow.run(async () => {
          const outcome = await this.settlement.applyPayment(payment);
          return this.close(eventId, outcome === 'UNKNOWN_ORDER' ? 'IGNORED' : 'PROCESSED', outcome === 'UNKNOWN_ORDER' ? 'unknown order' : outcome);
        });
      }
      case 'refund.processed':
      case 'refund.failed': {
        const refundId = str(envelope.data['refund_id']);
        if (!refundId) return this.close(eventId, 'IGNORED', 'missing refund_id');
        const refund = await this.provider.fetchRefund(refundId);
        if (!refund) throw new Error('the provider does not know this refund (yet)');
        return this.uow.run(async () => {
          const outcome = await this.refunds.applyProviderRefund(refund);
          return this.close(eventId, outcome === 'UNKNOWN_REFUND' ? 'IGNORED' : 'PROCESSED', outcome);
        });
      }
      default:
        return this.close(eventId, 'IGNORED', 'unsupported event type');
    }
  }

  private async close(eventId: string, status: 'PROCESSED' | 'IGNORED', note: string): Promise<WebhookResult> {
    await this.db
      .updateTable('payments.webhook_events')
      .set({ processing_status: status, processed_at: this.clock.now(), attempts: sql<number>`attempts + 1`, outcome: note, last_error: null })
      .where('id', '=', eventId)
      .execute();
    return status === 'PROCESSED' ? 'processed' : 'ignored';
  }
}
