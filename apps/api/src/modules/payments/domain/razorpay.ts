import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderPayment, ProviderRefund, WebhookEnvelope, WebhookSignatureError } from './payment-provider';

/**
 * Pure translation between Razorpay's wire format and our provider abstraction. Written against Razorpay's published
 * API reference (Payments, Orders, Refunds, Webhooks); no network, no framework, so it is tested directly.
 */

export interface RazorpayPaymentEntity {
  id?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  order_id?: unknown;
  amount_refunded?: unknown;
  created_at?: unknown;
  error_description?: unknown;
  error_reason?: unknown;
}

export interface RazorpayRefundEntity {
  id?: unknown;
  payment_id?: unknown;
  amount?: unknown;
  status?: unknown;
  receipt?: unknown;
  notes?: unknown;
}

const PROVIDER = 'razorpay';

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Razorpay response is missing "${field}"`);
  return v;
}

/** Razorpay amounts are integers in the smallest unit (paise). Anything else is a malformed response, never rounded. */
function minor(v: unknown, field: string): bigint {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`Razorpay response has an invalid "${field}"`);
  return BigInt(v);
}

/**
 * `captured` is the ONLY state that is money. `refunded` means "captured, then fully refunded" — it was money, and the
 * refund is tracked through `amount_refunded`. `created` / `authorized` are NOT money (capture is off by default at
 * Razorpay): they map to PENDING and are never credited. An unrecognised status also maps to PENDING — failing closed.
 */
export function mapRazorpayPayment(e: RazorpayPaymentEntity): ProviderPayment {
  const status = e.status === 'captured' || e.status === 'refunded' ? 'CAPTURED' : e.status === 'failed' ? 'FAILED' : 'PENDING';
  const createdAt = typeof e.created_at === 'number' && Number.isSafeInteger(e.created_at) ? new Date(e.created_at * 1000) : undefined;
  if (!createdAt) throw new Error('Razorpay response has an invalid "created_at"');
  const reason = [e.error_reason, e.error_description].find((x): x is string => typeof x === 'string' && x.length > 0);
  return {
    provider: PROVIDER,
    paymentId: str(e.id, 'id'),
    orderId: typeof e.order_id === 'string' ? e.order_id : '', // a payment with no order cannot be one of ours
    status,
    amountMinor: minor(e.amount, 'amount'),
    currency: str(e.currency, 'currency'),
    amountRefundedMinor: e.amount_refunded === undefined || e.amount_refunded === null ? 0n : minor(e.amount_refunded, 'amount_refunded'),
    createdAt,
    ...(status === 'FAILED' && reason ? { failureReason: reason.slice(0, 200) } : {}),
  };
}

export function mapRazorpayRefund(e: RazorpayRefundEntity): ProviderRefund {
  const notes = typeof e.notes === 'object' && e.notes !== null && !Array.isArray(e.notes) ? (e.notes as Record<string, unknown>) : {};
  const reference = typeof notes['reference'] === 'string' ? notes['reference'] : typeof e.receipt === 'string' ? e.receipt : '';
  return {
    provider: PROVIDER,
    refundId: str(e.id, 'id'),
    paymentId: str(e.payment_id, 'payment_id'),
    amountMinor: minor(e.amount, 'amount'),
    status: e.status === 'processed' ? 'PROCESSED' : e.status === 'failed' ? 'FAILED' : 'PENDING',
    reference,
  };
}

/**
 * HMAC-SHA256 over the RAW body with the webhook secret, hex, in `X-Razorpay-Signature`. Razorpay's scheme carries NO
 * timestamp, so a captured request can be replayed indefinitely: that is harmless here only because (a) events are
 * deduplicated on `x-razorpay-event-id` and (b) the payment itself is re-fetched from Razorpay before anything is credited.
 */
export function verifyRazorpaySignature(webhookSecret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signRazorpayWebhook(webhookSecret: string, rawBody: Buffer): string {
  return createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
}

/**
 * Authenticated body -> our envelope. The envelope only says "go and look at payment/refund X" — amounts and statuses in
 * it are never used. `payment.authorized` and `order.paid` are routed like a capture on purpose: the fetch decides what the
 * payment really is, so an `authorized` payment simply comes back PENDING and is not credited.
 */
export function parseRazorpayWebhook(rawBody: Buffer, eventId: string | undefined): WebhookEnvelope {
  if (!eventId || eventId.length > 200) throw new WebhookSignatureError('MALFORMED');
  let body: { event?: unknown; payload?: { payment?: { entity?: RazorpayPaymentEntity }; refund?: { entity?: RazorpayRefundEntity } } } | null;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as typeof body;
  } catch {
    throw new WebhookSignatureError('MALFORMED');
  }
  if (!body || typeof body.event !== 'string') throw new WebhookSignatureError('MALFORMED');

  switch (body.event) {
    case 'payment.authorized':
    case 'payment.captured':
    case 'order.paid':
    case 'payment.failed': {
      const p = body.payload?.payment?.entity;
      return { eventId, type: body.event === 'payment.failed' ? 'payment.failed' : 'payment.captured', data: { payment_id: typeof p?.id === 'string' ? p.id : undefined, order_id: typeof p?.order_id === 'string' ? p.order_id : undefined } };
    }
    case 'refund.created':
    case 'refund.processed':
    case 'refund.failed': {
      const r = body.payload?.refund?.entity;
      return { eventId, type: body.event === 'refund.failed' ? 'refund.failed' : 'refund.processed', data: { refund_id: typeof r?.id === 'string' ? r.id : undefined, payment_id: typeof r?.payment_id === 'string' ? r.payment_id : undefined } };
    }
    default:
      return { eventId, type: body.event, data: {} }; // acknowledged and ignored by the receiver
  }
}

/** Razorpay refund idempotency keys: at least 10 characters of letters, digits, hyphen and underscore. */
export const isValidRefundIdempotencyKey = (key: string) => /^[A-Za-z0-9_-]{10,}$/.test(key);
