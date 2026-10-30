import { Inject, Injectable } from '@nestjs/common';
import { AuthorizationService } from '../../identity-access';
import {
  APP_CONFIG,
  AppConfig,
  Clock,
  DomainError,
  Money,
  NotFoundError,
  OutboxService,
  UnitOfWork,
  uuidv7,
} from '../../../shared-kernel';
import { PaymentProvider } from '../domain/payment-provider';
import type { IntentRow, IntentStatus, PaymentsDb } from '../infrastructure/db-types';
import { PaymentRecoveryService, firstCheckDelaySeconds } from './payment-recovery.service';

const CURRENCY = 'INR';

export interface PaymentIntentView {
  id: string;
  status: IntentStatus;
  purpose: 'WALLET_TOPUP';
  amount: { amount_minor: number; currency: string };
  provider: string;
  /** What the app needs to open the provider's checkout. Present only while the intent can still be paid. */
  checkout: Record<string, unknown> | null;
  expires_at: string;
  succeeded_at: string | null;
  created_at: string;
}

/**
 * A customer's request to add money to their wallet. Creating an intent moves no money and credits nothing: the
 * wallet is credited only when the provider confirms the capture SERVER-SIDE (see PaymentSettlementService).
 */
@Injectable()
export class PaymentIntentService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly authz: AuthorizationService,
    private readonly provider: PaymentProvider,
    private readonly recovery: PaymentRecoveryService,
  ) {}

  private get db() {
    return this.uow.db<PaymentsDb>();
  }

  /**
   * The amount comes from the client but is only ever a REQUEST: it is bounded by server-side limits and the
   * provider is asked for exactly that amount. Replaying the same idempotency key returns the same intent.
   */
  async create(customerId: string, input: { amountMinor: number; idempotencyKey: string }): Promise<PaymentIntentView> {
    await this.authz.require(customerId, 'wallet:topup');
    if (!Number.isSafeInteger(input.amountMinor)) throw new DomainError('INVALID_AMOUNT', 'The amount must be a whole number of paise', 422);
    const amount = BigInt(input.amountMinor);
    const { topupMinMinor: min, topupMaxMinor: max, topupIntentTtlMinutes } = this.config.payments;
    if (amount < min || amount > max) {
      throw new DomainError('TOPUP_AMOUNT_OUT_OF_RANGE', 'This amount is outside the allowed range for adding money', 422, {
        min: Money.of(min, CURRENCY).toJSON(),
        max: Money.of(max, CURRENCY).toJSON(),
      });
    }

    return this.uow.run(async () => {
      const prior = await this.db.selectFrom('payments.payment_intents').selectAll().where('customer_id', '=', customerId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (prior) return this.toView(prior);

      const now = this.clock.now();
      const id = uuidv7();
      // The provider is an external system: its order is created with our intent id as the receipt, so a retry that
      // reaches it twice still yields one order. An order orphaned by a lost race is harmless (it can never be paid
      // into an intent that does not reference it).
      const order = await this.provider.createOrder({ amountMinor: amount, currency: CURRENCY, receipt: id });

      const inserted = await this.db
        .insertInto('payments.payment_intents')
        .values({
          id,
          customer_id: customerId,
          amount_minor: amount.toString(),
          currency: CURRENCY,
          provider: this.provider.name,
          provider_order_id: order.orderId,
          idempotency_key: input.idempotencyKey,
          expires_at: new Date(now.getTime() + topupIntentTtlMinutes * 60_000),
          succeeded_at: null,
          created_at: now,
        })
        .onConflict((oc) => oc.columns(['customer_id', 'idempotency_key']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!inserted) {
        const winner = await this.db.selectFrom('payments.payment_intents').selectAll().where('customer_id', '=', customerId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirstOrThrow();
        return this.toView(winner);
      }

      // Safety net for a callback that never arrives: the worker will ask the provider what happened.
      await this.outbox.publish({
        type: 'payments.intent_check',
        aggregateType: 'payment_intent',
        aggregateId: id,
        payload: { intent_id: id, attempt: 1 },
        availableAt: new Date(now.getTime() + firstCheckDelaySeconds() * 1000),
      });
      return this.toView(inserted);
    });
  }

  /** Owner-only. Anyone else gets 404 — the existence of another customer's payment is not disclosed. */
  async get(customerId: string, intentId: string): Promise<PaymentIntentView> {
    return this.toView(await this.mine(customerId, intentId));
  }

  async list(customerId: string, opts: { limit: number; cursor?: string }): Promise<{ data: PaymentIntentView[]; nextCursor: string | null }> {
    let q = this.db.selectFrom('payments.payment_intents').selectAll().where('customer_id', '=', customerId).orderBy('id', 'desc').limit(opts.limit + 1);
    if (opts.cursor) q = q.where('id', '<', opts.cursor);
    const rows = await q.execute();
    const page = rows.slice(0, opts.limit);
    return { data: page.map((r) => this.toView(r)), nextCursor: rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  /**
   * "I came back from checkout — did it work?" The CLIENT'S word is never used: this asks the provider, then
   * returns whatever the book now says. Safe to call repeatedly.
   */
  async verify(customerId: string, intentId: string): Promise<PaymentIntentView> {
    await this.mine(customerId, intentId);
    await this.recovery.recoverIntent(intentId, { reschedule: false });
    return this.get(customerId, intentId);
  }

  private async mine(customerId: string, intentId: string): Promise<IntentRow> {
    const row = await this.db.selectFrom('payments.payment_intents').selectAll().where('id', '=', intentId).where('customer_id', '=', customerId).executeTakeFirst();
    if (!row) throw new NotFoundError('Payment');
    return row;
  }

  private toView(r: IntentRow): PaymentIntentView {
    return {
      id: r.id,
      status: r.status,
      purpose: 'WALLET_TOPUP',
      amount: Money.of(BigInt(r.amount_minor), r.currency).toJSON(),
      provider: r.provider,
      checkout: r.status === 'PENDING' ? this.provider.checkoutPayload(r.provider_order_id) : null,
      expires_at: r.expires_at.toISOString(),
      succeeded_at: r.succeeded_at ? r.succeeded_at.toISOString() : null,
      created_at: r.created_at.toISOString(),
    };
  }
}
