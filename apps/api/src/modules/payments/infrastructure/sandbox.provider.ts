import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig, Clock } from '../../../shared-kernel';
import {
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderRefund,
  ProviderRejectedError,
  WebhookEnvelope,
  WebhookSignatureError,
} from '../domain/payment-provider';
import { signWebhook, verifyWebhookSignature } from '../domain/webhook-signature';
import type { PaymentsDb, SandboxPaymentsTable, SandboxRefundsTable } from './db-types';

export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';

export interface SignedWebhook {
  eventId: string;
  rawBody: Buffer;
  headers: Record<string, string>;
}

const newId = (prefix: string) => `${prefix}_sbx_${randomUUID().replace(/-/g, '')}`;

/**
 * A payment provider that exists ONLY in this database. It behaves like a real PSP where it matters for
 * correctness — server-side fetch, one capture per order, idempotent refunds, signed webhooks — and moves
 * no money. It talks to the database through its OWN small connection pool (never the request's transaction,
 * never the application's pool), because a real provider is a separate system: its state does not roll back
 * with ours, and calling it must not compete with the application for connections.
 *
 * Refused in production by `loadConfig` (docs §K.4). Not a mock: there is no code path that fakes a result.
 */
@Injectable()
export class SandboxPaymentProvider extends PaymentProvider implements OnModuleDestroy {
  readonly name = 'sandbox';
  private kysely?: Kysely<PaymentsDb>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    super();
  }

  /** Created on first use, so a deployment that never selects the sandbox never opens these connections. */
  private get db(): Kysely<PaymentsDb> {
    this.kysely ??= new Kysely<PaymentsDb>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: this.config.databaseUrl, max: 4 }) }) });
    return this.kysely;
  }

  async onModuleDestroy(): Promise<void> {
    await this.kysely?.destroy();
  }

  // ===== the PaymentProvider contract =================================================================================
  async createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<ProviderOrder> {
    await this.db
      .insertInto('payments.sandbox_orders')
      .values({ provider_order_id: newId('order'), amount_minor: input.amountMinor.toString(), currency: input.currency, receipt: input.receipt, created_at: this.clock.now() })
      .onConflict((oc) => oc.column('receipt').doNothing()) // same receipt => same order (idempotent)
      .execute();
    const row = await this.db.selectFrom('payments.sandbox_orders').select('provider_order_id').where('receipt', '=', input.receipt).executeTakeFirstOrThrow();
    return { orderId: row.provider_order_id };
  }

  checkoutPayload(orderId: string): Record<string, unknown> {
    return { provider: this.name, order_id: orderId, sandbox: true, pay_endpoint: '/api/v1/payments/sandbox/pay' };
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment | null> {
    const row = await this.db.selectFrom('payments.sandbox_payments').selectAll().where('provider_payment_id', '=', paymentId).executeTakeFirst();
    return row ? (await this.withRefunded([row]))[0]! : null;
  }

  async listOrderPayments(orderId: string): Promise<ProviderPayment[]> {
    const rows = await this.db.selectFrom('payments.sandbox_payments').selectAll().where('provider_order_id', '=', orderId).orderBy('created_at').orderBy('provider_payment_id').execute();
    return this.withRefunded(rows);
  }

  async listPayments(range: { from: Date; to: Date }): Promise<ProviderPayment[]> {
    const rows = await this.db
      .selectFrom('payments.sandbox_payments')
      .selectAll()
      .where('created_at', '>=', range.from)
      .where('created_at', '<', range.to)
      .orderBy('created_at')
      .orderBy('provider_payment_id')
      .execute();
    return this.withRefunded(rows);
  }

  async createRefund(input: { paymentId: string; amountMinor: bigint; idempotencyKey: string }): Promise<ProviderRefund> {
    const prior = await this.db.selectFrom('payments.sandbox_refunds').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
    if (prior) return this.toRefund(prior);

    const payment = await this.db.selectFrom('payments.sandbox_payments').selectAll().where('provider_payment_id', '=', input.paymentId).executeTakeFirst();
    if (!payment) throw new ProviderRejectedError('PAYMENT_NOT_FOUND', 'No such payment');
    if (payment.status !== 'CAPTURED') throw new ProviderRejectedError('PAYMENT_NOT_CAPTURED', 'Only a captured payment can be refunded');
    if (input.amountMinor <= 0n) throw new ProviderRejectedError('INVALID_AMOUNT', 'Refund amount must be positive');

    const refunded = await this.db
      .selectFrom('payments.sandbox_refunds')
      .select((eb) => eb.fn.sum<string>('amount_minor').as('total'))
      .where('provider_payment_id', '=', input.paymentId)
      .where('status', '<>', 'FAILED')
      .executeTakeFirst();
    if (BigInt(refunded?.total ?? '0') + input.amountMinor > BigInt(payment.amount_minor)) {
      throw new ProviderRejectedError('REFUND_EXCEEDS_PAYMENT', 'The refund exceeds what was paid');
    }

    await this.db
      .insertInto('payments.sandbox_refunds')
      .values({ provider_refund_id: newId('rfnd'), provider_payment_id: input.paymentId, amount_minor: input.amountMinor.toString(), idempotency_key: input.idempotencyKey, status: 'PENDING', created_at: this.clock.now() })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .execute();
    const row = await this.db.selectFrom('payments.sandbox_refunds').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirstOrThrow();
    return this.toRefund(row);
  }

  async fetchRefund(refundId: string): Promise<ProviderRefund | null> {
    const row = await this.db.selectFrom('payments.sandbox_refunds').selectAll().where('provider_refund_id', '=', refundId).executeTakeFirst();
    return row ? this.toRefund(row) : null;
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEnvelope {
    const header = headers[SANDBOX_SIGNATURE_HEADER];
    const verdict = verifyWebhookSignature(this.config.payments.webhookSecret, Array.isArray(header) ? header[0] : header, rawBody, this.clock.now().getTime());
    if (!verdict.ok) throw new WebhookSignatureError(verdict.reason);

    // Authentic bytes, but they must still be a well-formed envelope. MALFORMED covers a bad header or body.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookSignatureError('MALFORMED');
    }
    const body = parsed as { id?: unknown; type?: unknown; data?: unknown } | null;
    if (!body || typeof body.id !== 'string' || !body.id || typeof body.type !== 'string' || typeof body.data !== 'object' || body.data === null) {
      throw new WebhookSignatureError('MALFORMED');
    }
    return { eventId: body.id, type: body.type, data: body.data as Record<string, unknown> };
  }

  // ===== simulator controls (what a customer / the bank would do) ====================================================
  /** The customer completes (or fails) checkout for an order. `amountMinor` lets a test simulate a wrong amount. */
  async simulatePayment(input: { orderId: string; outcome: 'SUCCESS' | 'FAILURE'; amountMinor?: bigint }): Promise<ProviderPayment> {
    const order = await this.db.selectFrom('payments.sandbox_orders').selectAll().where('provider_order_id', '=', input.orderId).executeTakeFirst();
    if (!order) throw new ProviderRejectedError('ORDER_NOT_FOUND', 'No such order');
    const status: SandboxPaymentsTable['status'] = input.outcome === 'SUCCESS' ? 'CAPTURED' : 'FAILED';
    const id = newId('pay');
    try {
      await this.db
        .insertInto('payments.sandbox_payments')
        .values({ provider_payment_id: id, provider_order_id: order.provider_order_id, amount_minor: (input.amountMinor ?? BigInt(order.amount_minor)).toString(), currency: order.currency, status, created_at: this.clock.now() })
        .execute();
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'sandbox_payments_one_capture_per_order') {
        throw new ProviderRejectedError('ORDER_ALREADY_PAID', 'This order has already been paid');
      }
      throw err;
    }
    return (await this.fetchPayment(id))!;
  }

  /** The bank finishes (or refuses) a refund that was PENDING. */
  async settleRefund(refundId: string, outcome: 'PROCESSED' | 'FAILED'): Promise<ProviderRefund> {
    await this.db.updateTable('payments.sandbox_refunds').set({ status: outcome }).where('provider_refund_id', '=', refundId).execute();
    return (await this.fetchRefund(refundId))!;
  }

  // ===== webhook delivery (what the provider would send us) ==========================================================
  /** Builds a correctly signed webhook. `eventId` / `timestampSeconds` can be pinned to simulate redelivery. */
  buildWebhook(input: { type: string; data: Record<string, unknown>; eventId?: string; timestampSeconds?: number }): SignedWebhook {
    const eventId = input.eventId ?? `evt_sbx_${randomUUID().replace(/-/g, '')}`;
    const rawBody = Buffer.from(JSON.stringify({ id: eventId, type: input.type, created_at: this.clock.now().toISOString(), data: input.data }), 'utf8');
    const timestamp = input.timestampSeconds ?? Math.floor(this.clock.now().getTime() / 1000);
    return {
      eventId,
      rawBody,
      headers: { 'content-type': 'application/json', [SANDBOX_SIGNATURE_HEADER]: signWebhook(this.config.payments.webhookSecret, timestamp, rawBody) },
    };
  }

  paymentWebhook(payment: ProviderPayment, opts: { eventId?: string; timestampSeconds?: number } = {}): SignedWebhook {
    return this.buildWebhook({
      type: payment.status === 'CAPTURED' ? 'payment.captured' : 'payment.failed',
      // Hints only. The receiver re-fetches the payment from the provider and ignores these amounts.
      data: { payment_id: payment.paymentId, order_id: payment.orderId, amount_minor: Number(payment.amountMinor), status: payment.status },
      ...opts,
    });
  }

  refundWebhook(refund: ProviderRefund, opts: { eventId?: string; timestampSeconds?: number } = {}): SignedWebhook {
    return this.buildWebhook({
      type: refund.status === 'FAILED' ? 'refund.failed' : 'refund.processed',
      data: { refund_id: refund.refundId, payment_id: refund.paymentId, status: refund.status },
      ...opts,
    });
  }

  // ===== mapping =====================================================================================================
  private async withRefunded(rows: SandboxPaymentsTable[]): Promise<ProviderPayment[]> {
    if (rows.length === 0) return [];
    const sums = await this.db
      .selectFrom('payments.sandbox_refunds')
      .select(['provider_payment_id', (eb) => eb.fn.sum<string>('amount_minor').as('total')])
      .where('provider_payment_id', 'in', rows.map((r) => r.provider_payment_id))
      .where('status', '<>', 'FAILED')
      .groupBy('provider_payment_id')
      .execute();
    const refunded = new Map(sums.map((s) => [s.provider_payment_id, BigInt(s.total)]));
    return rows.map((row) => this.toPayment(row, refunded.get(row.provider_payment_id) ?? 0n));
  }

  private toPayment(row: SandboxPaymentsTable, refunded: bigint): ProviderPayment {
    return { provider: this.name, paymentId: row.provider_payment_id, orderId: row.provider_order_id, status: row.status, amountMinor: BigInt(row.amount_minor), currency: row.currency, amountRefundedMinor: refunded, createdAt: row.created_at };
  }

  private toRefund(row: SandboxRefundsTable): ProviderRefund {
    return { provider: this.name, refundId: row.provider_refund_id, paymentId: row.provider_payment_id, amountMinor: BigInt(row.amount_minor), status: row.status, reference: row.idempotency_key };
  }
}
