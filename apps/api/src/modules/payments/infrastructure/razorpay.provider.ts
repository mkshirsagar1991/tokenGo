import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, DomainError } from '../../../shared-kernel';
import {
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderRefund,
  ProviderRejectedError,
  WebhookEnvelope,
  WebhookSignatureError,
} from '../domain/payment-provider';
import {
  RazorpayPaymentEntity,
  RazorpayRefundEntity,
  isValidRefundIdempotencyKey,
  mapRazorpayPayment,
  mapRazorpayRefund,
  parseRazorpayWebhook,
  verifyRazorpaySignature,
} from '../domain/razorpay';

const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100; // Razorpay's maximum `count`
const MAX_PAGES = 50; // a window with more than 5 000 payments must be reconciled in smaller pieces, never silently truncated

/** A non-2xx answer from Razorpay, classified by the caller. */
class RazorpayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly description: string,
    /** True only when the answer carried Razorpay's own `error` object. A bare 404 such as {"message":"no Route matched…"} comes from their API GATEWAY, not their application. */
    readonly hasErrorBody: boolean,
  ) {
    super(`Razorpay ${status} ${code}: ${description}`);
  }
}

interface Collection<T> {
  items?: T[];
}

/**
 * Razorpay (TEST MODE ONLY — `loadConfig` refuses live keys and refuses this provider in production).
 * Built to Razorpay's published API reference; verified here only against a local test double, NOT against Razorpay itself.
 *
 * Error policy (this decides whether a customer's money is touched):
 *   - network error, timeout, 5xx, 429, 409 (request in flight), 401/403 (our credentials/permissions) -> TRANSIENT: a plain
 *     Error, so the caller retries and nothing is assumed about the outcome. A bad API key must never be mistaken for
 *     "Razorpay refused the refund", which would hand the customer their money back while the refund may still go out.
 *   - 400/404 WITH a Razorpay `error` body -> DEFINITIVE: ProviderRejectedError. (A bare 404 comes from their gateway — see classify().)
 */
@Injectable()
export class RazorpayPaymentProvider extends PaymentProvider {
  readonly name = 'razorpay';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  private get cfg() {
    const c = this.config.payments.razorpay;
    if (!c) throw new DomainError('PAYMENTS_DISABLED', 'Adding money is not available right now', 503);
    return c;
  }

  // ===== the PaymentProvider contract =================================================================================
  async createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<ProviderOrder> {
    if (input.receipt.length > 40) throw new ProviderRejectedError('RECEIPT_TOO_LONG', 'Razorpay receipts are limited to 40 characters');
    const order = await this.call<{ id?: unknown }>('POST', '/orders', {
      body: { amount: Number(input.amountMinor), currency: input.currency, receipt: input.receipt, notes: { intent_id: input.receipt } },
    });
    if (typeof order.id !== 'string' || !order.id) throw new Error('Razorpay did not return an order id');
    return { orderId: order.id };
  }

  /** Public, non-secret values the app's Razorpay Checkout needs. The key SECRET never leaves the server. */
  checkoutPayload(orderId: string): Record<string, unknown> {
    return { provider: this.name, key_id: this.cfg.keyId, order_id: orderId, test_mode: true };
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment | null> {
    const entity = await this.callOrNull<RazorpayPaymentEntity>('GET', `/payments/${encodeURIComponent(paymentId)}`);
    return entity ? mapRazorpayPayment(entity) : null;
  }

  async listOrderPayments(orderId: string): Promise<ProviderPayment[]> {
    const res = await this.callOrNull<Collection<RazorpayPaymentEntity>>('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
    return (res?.items ?? []).map(mapRazorpayPayment).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.paymentId.localeCompare(b.paymentId));
  }

  async listPayments(range: { from: Date; to: Date }): Promise<ProviderPayment[]> {
    const out: ProviderPayment[] = [];
    // Razorpay filters on whole seconds, inclusive; the exact [from, to) window is applied afterwards.
    const from = Math.floor(range.from.getTime() / 1000);
    const to = Math.ceil(range.to.getTime() / 1000);
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new Error('Too many payments in this window to list reliably; reconcile a shorter period');
      const res = await this.call<Collection<RazorpayPaymentEntity>>('GET', '/payments', { query: { from, to, count: PAGE_SIZE, skip: page * PAGE_SIZE } });
      const items = res.items ?? [];
      for (const item of items) out.push(mapRazorpayPayment(item));
      if (items.length < PAGE_SIZE) break;
    }
    return out
      .filter((p) => p.createdAt >= range.from && p.createdAt < range.to)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.paymentId.localeCompare(b.paymentId));
  }

  async createRefund(input: { paymentId: string; amountMinor: bigint; idempotencyKey: string }): Promise<ProviderRefund> {
    if (!isValidRefundIdempotencyKey(input.idempotencyKey)) {
      throw new ProviderRejectedError('INVALID_IDEMPOTENCY_KEY', 'Refund idempotency keys must be 10+ characters of letters, digits, - and _');
    }
    const entity = await this.call<RazorpayRefundEntity>('POST', `/payments/${encodeURIComponent(input.paymentId)}/refund`, {
      // The idempotency key is what makes "we never saw the response" safe to retry: Razorpay returns the SAME refund.
      headers: { 'X-Refund-Idempotency': input.idempotencyKey },
      body: { amount: Number(input.amountMinor), speed: 'normal', receipt: input.idempotencyKey.slice(0, 40), notes: { reference: input.idempotencyKey } },
    });
    const refund = mapRazorpayRefund(entity);
    // Echo our own id back even if Razorpay's copy of the notes is missing, so webhooks/polls can be correlated.
    return { ...refund, reference: refund.reference || input.idempotencyKey };
  }

  async fetchRefund(refundId: string): Promise<ProviderRefund | null> {
    const entity = await this.callOrNull<RazorpayRefundEntity>('GET', `/refunds/${encodeURIComponent(refundId)}`);
    return entity ? mapRazorpayRefund(entity) : null;
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEnvelope {
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    const signature = one(headers['x-razorpay-signature']);
    if (!signature) throw new WebhookSignatureError('MISSING');
    if (!verifyRazorpaySignature(this.cfg.webhookSecret, rawBody, signature)) throw new WebhookSignatureError(/^[0-9a-f]{64}$/i.test(signature) ? 'MISMATCH' : 'MALFORMED');
    return parseRazorpayWebhook(rawBody, one(headers['x-razorpay-event-id']));
  }

  // ===== HTTP ======================================================================================================
  /** GET/POST with the error already classified (definitive refusal vs. retryable). */
  private async call<T>(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string | number>; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    try {
      return await this.raw<T>(method, path, opts);
    } catch (err) {
      throw this.classify(err);
    }
  }

  /** GET/POST; throws RazorpayHttpError (unclassified) for anything that is not a 2xx. */
  private async raw<T>(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string | number>; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const cfg = this.cfg;
    const url = new URL(cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`,
          Accept: 'application/json',
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // We do not know whether the request reached Razorpay. The message deliberately omits the URL and headers.
      throw new Error(`Razorpay is unreachable (${err instanceof Error ? err.name : 'error'})`, { cause: err });
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: handled by the status below
    }
    if (res.ok) {
      if (json === null || typeof json !== 'object') throw new Error('Razorpay returned an unreadable response');
      return json as T;
    }
    const err = (json as { error?: { code?: unknown; description?: unknown } } | null)?.error;
    const hasErrorBody = typeof err?.code === 'string';
    throw new RazorpayHttpError(res.status, hasErrorBody ? (err!.code as string) : `HTTP_${res.status}`, typeof err?.description === 'string' ? err.description.slice(0, 300) : `HTTP ${res.status}`, hasErrorBody);
  }

  /** Like `call`, but "this id does not exist" is `null`, and every other failure is classified for the caller. */
  private async callOrNull<T>(method: 'GET', path: string): Promise<T | null> {
    try {
      return await this.raw<T>(method, path);
    } catch (err) {
      // Verified against the real API: a valid-format id that does not exist answers 400 with an error body ("The id provided does
      // not exist", or "invalid request sent" for refunds). A bare 404 is a gateway/routing problem — NOT "it does not exist".
      if (err instanceof RazorpayHttpError && err.status === 400 && err.hasErrorBody) return null;
      throw this.classify(err);
    }
  }

  /** Definitive refusals become ProviderRejectedError; everything uncertain stays a plain (retryable) Error. */
  private classify(err: unknown): Error {
    if (!(err instanceof RazorpayHttpError)) return err instanceof Error ? err : new Error(String(err));
    // DEFINITIVE only when Razorpay's application answered with an error object. A gateway 404 ("no Route matched") says nothing
    // about whether the operation happened, so it is retried like any other uncertain failure.
    if ((err.status === 400 || err.status === 404) && err.hasErrorBody) return new ProviderRejectedError(err.code, err.description);
    return new Error(`Razorpay temporarily unavailable, not routed or not authorised (HTTP ${err.status})`);
  }
}
