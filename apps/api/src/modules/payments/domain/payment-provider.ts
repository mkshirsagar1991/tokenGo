/**
 * The payment-provider abstraction (requirements §14, proposal §K). The rest of the module talks ONLY to this
 * interface, so swapping the sandbox for a real PSP later is a new implementation plus a legal/PSP review —
 * not a rewrite. Everything the provider tells us is treated as UNTRUSTED INPUT until it comes back from
 * `fetchPayment`/`fetchRefund` (a server-to-server call), never from a webhook body or a client.
 */
/**
 * PENDING = not final and NOT money yet (e.g. a card payment that is authorised but not captured). It is never credited;
 * it is simply looked at again later.
 */
export type ProviderPaymentStatus = 'CAPTURED' | 'FAILED' | 'PENDING';
export type ProviderRefundStatus = 'PENDING' | 'PROCESSED' | 'FAILED';

export interface ProviderOrder {
  orderId: string;
}

export interface ProviderPayment {
  provider: string;
  paymentId: string;
  orderId: string;
  status: ProviderPaymentStatus;
  /** What the PROVIDER says it took — compared with the intent, never assumed equal. */
  amountMinor: bigint;
  currency: string;
  /** How much of this payment the provider says has been refunded — reconciliation uses it to spot refunds we did not make. */
  amountRefundedMinor: bigint;
  createdAt: Date;
  failureReason?: string;
}

export interface ProviderRefund {
  provider: string;
  refundId: string;
  paymentId: string;
  amountMinor: bigint;
  status: ProviderRefundStatus;
  /** Our own id for the refund (the idempotency key we sent), echoed back so a webhook can be correlated. */
  reference: string;
}

/** A parsed, AUTHENTICATED webhook. The payload inside is still only a hint about what to go and fetch. */
export interface WebhookEnvelope {
  eventId: string;
  type: string;
  data: Record<string, unknown>;
}

export type WebhookRejection = 'MISSING' | 'MALFORMED' | 'MISMATCH' | 'STALE';

export class WebhookSignatureError extends Error {
  constructor(readonly reason: WebhookRejection) {
    super(`Webhook rejected: ${reason}`);
    this.name = 'WebhookSignatureError';
  }
}

/** The provider definitively refused (e.g. invalid amount): safe to treat as failed, unlike a network error. */
export class ProviderRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

export abstract class PaymentProvider {
  /** Stable identifier stored with every record (`sandbox`, later e.g. a real PSP). */
  abstract readonly name: string;

  abstract createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<ProviderOrder>;

  /** What the app needs to launch the provider's checkout. Pure: derived from ids only. */
  abstract checkoutPayload(orderId: string): Record<string, unknown>;

  abstract fetchPayment(paymentId: string): Promise<ProviderPayment | null>;
  abstract listOrderPayments(orderId: string): Promise<ProviderPayment[]>;
  /** Every payment the provider created in [from, to) — the provider's side of reconciliation. */
  abstract listPayments(range: { from: Date; to: Date }): Promise<ProviderPayment[]>;

  /** Idempotent at the provider: the same `idempotencyKey` always returns the same refund. */
  abstract createRefund(input: { paymentId: string; amountMinor: bigint; idempotencyKey: string }): Promise<ProviderRefund>;
  abstract fetchRefund(refundId: string): Promise<ProviderRefund | null>;

  /** Authenticates a webhook over its RAW bytes; throws {@link WebhookSignatureError} when it is not genuine. */
  abstract verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEnvelope;
}
