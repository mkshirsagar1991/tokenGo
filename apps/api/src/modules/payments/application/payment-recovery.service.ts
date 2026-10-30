import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { Clock, LOGGER, OutboxService, UnitOfWork } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { PaymentProvider } from '../domain/payment-provider';
import type { IntentStatus, PaymentsDb } from '../infrastructure/db-types';
import { PaymentSettlementService } from './payment-settlement.service';
import { RefundService } from './refund.service';

/** First "did it happen?" check after an intent is created; later checks back off up to MAX. */
const FIRST_CHECK_SECONDS = 120;
const MAX_CHECK_SECONDS = 600;
/** The sweeper only looks at things at least this old, so it never races a normal, fast callback. */
const SWEEP_MIN_AGE_MS = 5 * 60_000;
const SWEEP_BATCH = 100;
const REJECTED_WEBHOOK_RETENTION_MS = 14 * 86_400_000;

export const firstCheckDelaySeconds = () => FIRST_CHECK_SECONDS;
const nextCheckDelaySeconds = (attempt: number) => Math.min(FIRST_CHECK_SECONDS * 2 ** (attempt - 1), MAX_CHECK_SECONDS);

/**
 * Callbacks get lost, delayed and duplicated; the money does not care. This service asks the provider directly
 * what happened, so a top-up is settled even if its webhook never arrives (requirements §14 "payment callback
 * delayed"). Two independent triggers feed it, so neither is a single point of failure:
 *   - a per-intent chain of outbox events (each check schedules the next, until the intent settles or expires);
 *   - a periodic sweeper in the worker for anything the chain lost.
 * Everything it does is idempotent and goes through the SAME settlement code as a webhook.
 */
@Injectable()
export class PaymentRecoveryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly provider: PaymentProvider,
    private readonly settlement: PaymentSettlementService,
    private readonly refunds: RefundService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private get db() {
    return this.uow.db<PaymentsDb>();
  }

  /**
   * Polls the provider for the intent's payments and settles whatever it finds. If the intent is still unpaid it
   * expires once its time is up, otherwise (when asked) schedules the next check. Returns the resulting status.
   */
  async recoverIntent(intentId: string, opts: { reschedule: boolean; attempt?: number }): Promise<IntentStatus | 'MISSING'> {
    const intent = await this.db.selectFrom('payments.payment_intents').selectAll().where('id', '=', intentId).executeTakeFirst();
    if (!intent) return 'MISSING';
    if (intent.status !== 'PENDING') return intent.status;

    // External call first, outside any lock. A payment found here is applied even if the intent is about to expire.
    const payments = await this.provider.listOrderPayments(intent.provider_order_id);
    for (const payment of payments) await this.settlement.applyPayment(payment);

    return this.uow.run(async () => {
      const fresh = await this.db.selectFrom('payments.payment_intents').selectAll().where('id', '=', intentId).forUpdate().executeTakeFirstOrThrow();
      if (fresh.status !== 'PENDING') return fresh.status;
      const now = this.clock.now();

      if (fresh.expires_at.getTime() <= now.getTime()) {
        await this.db.updateTable('payments.payment_intents').set({ status: 'EXPIRED', updated_at: now }).where('id', '=', intentId).execute();
        await this.audit.record({ actorType: 'SYSTEM', action: 'payment_intent.expired', entityType: 'payment_intent', entityId: intentId });
        await this.outbox.publish({ type: 'payments.intent_expired', aggregateType: 'payment_intent', aggregateId: intentId, payload: { intent_id: intentId, customer_id: fresh.customer_id } });
        return 'EXPIRED';
      }
      if (opts.reschedule) {
        const attempt = (opts.attempt ?? 1) + 1;
        const next = Math.min(now.getTime() + nextCheckDelaySeconds(attempt) * 1000, fresh.expires_at.getTime());
        await this.outbox.publish({ type: 'payments.intent_check', aggregateType: 'payment_intent', aggregateId: intentId, payload: { intent_id: intentId, attempt }, availableAt: new Date(next) });
      }
      return 'PENDING';
    });
  }

  /**
   * Safety net, run periodically by the worker: re-checks stale PENDING intents, re-submits stale PROCESSING refunds
   * and trims forged-webhook rows. Safe to run concurrently on several workers — every step is idempotent.
   */
  async sweep(): Promise<{ intents: number; refunds: number; purgedWebhooks: number }> {
    const cutoff = new Date(this.clock.now().getTime() - SWEEP_MIN_AGE_MS);

    const intents = await this.db.selectFrom('payments.payment_intents').select('id').where('status', '=', 'PENDING').where('created_at', '<', cutoff).orderBy('created_at').limit(SWEEP_BATCH).execute();
    let intentsHandled = 0;
    for (const { id } of intents) {
      try {
        await this.recoverIntent(id, { reschedule: false });
        intentsHandled += 1;
      } catch (err) {
        this.logger.warn({ intent_id: id, err }, 'payment recovery: intent check failed');
      }
    }

    const refunds = await this.db.selectFrom('payments.refunds').select('id').where('status', '=', 'PROCESSING').where('created_at', '<', cutoff).orderBy('created_at').limit(SWEEP_BATCH).execute();
    let refundsHandled = 0;
    for (const { id } of refunds) {
      try {
        await this.refunds.submit(id);
        refundsHandled += 1;
      } catch (err) {
        this.logger.warn({ refund_id: id, err }, 'payment recovery: refund submit failed');
      }
    }

    const purged = await this.db
      .deleteFrom('payments.webhook_events')
      .where('processing_status', '=', 'REJECTED')
      .where('received_at', '<', new Date(this.clock.now().getTime() - REJECTED_WEBHOOK_RETENTION_MS))
      .executeTakeFirst();
    return { intents: intentsHandled, refunds: refundsHandled, purgedWebhooks: Number(purged.numDeletedRows ?? 0) };
  }
}
