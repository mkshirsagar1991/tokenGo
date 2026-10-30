import { createHash, randomBytes } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signRazorpayWebhook } from '../../src/modules/payments/domain/razorpay';

/**
 * A LOCAL TEST DOUBLE of the parts of Razorpay's REST API that the payments module uses, written from Razorpay's published
 * API reference. It is NOT Razorpay: passing against it proves our requests/handling match the documentation as I read it,
 * not that real Razorpay behaves identically. It exists so the money-critical paths can be exercised deterministically.
 *
 * Documented behaviours reproduced: Basic auth; amounts in paise; `count` <= 100 with `skip`; 400 + "id does not exist" for unknown
 * ids; capture is not automatic (a payment can sit `authorized`); `X-Refund-Idempotency` (same key + same body => same refund,
 * same key + different body => 400); refunds start `pending`.
 * Fault injection: drop the response after the refund was created, answer 409 (request in flight), answer 401, answer 500.
 */
export interface FakePayment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  order_id: string;
  method: string;
  amount_refunded: number;
  refund_status: string | null;
  captured: boolean;
  error_code: string | null;
  error_description: string | null;
  error_reason: string | null;
  created_at: number;
}
export interface FakeRefund {
  id: string;
  entity: 'refund';
  amount: number;
  currency: string;
  payment_id: string;
  receipt: string | null;
  notes: Record<string, unknown>;
  created_at: number;
  status: 'pending' | 'processed' | 'failed';
  speed_requested: string;
  speed_processed: string;
}
interface Order {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: string;
  attempts: number;
  notes: unknown;
  created_at: number;
}
export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | null;
}

const id = (prefix: string) => `${prefix}_${randomBytes(7).toString('base64url').replace(/[-_]/g, 'x')}`;

export class FakeRazorpay {
  readonly orders = new Map<string, Order>();
  readonly payments = new Map<string, FakePayment>();
  readonly refunds = new Map<string, FakeRefund>();
  readonly requests: RecordedRequest[] = [];
  private readonly refundKeys = new Map<string, { bodyHash: string; refundId: string }>();
  private faults: { refundDropResponse: number; refund409: number; refund500: number; refund401: number; order500: number; refundGateway404: number } = { refundDropResponse: 0, refund409: 0, refund500: 0, refund401: 0, order500: 0, refundGateway404: 0 };
  private server!: Server;
  baseUrl = '';

  constructor(
    private readonly creds: { keyId: string; keySecret: string; webhookSecret: string },
    private readonly now: () => Date,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => res.destroy()));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ===== test controls ================================================================================================
  /** The customer completes checkout. `authorized` models Razorpay with auto-capture OFF (the default). */
  pay(orderId: string, opts: { status?: FakePayment['status']; amount?: number; reason?: string } = {}): FakePayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`fake razorpay: no order ${orderId}`);
    const status = opts.status ?? 'captured';
    const p: FakePayment = {
      id: id('pay'),
      entity: 'payment',
      amount: opts.amount ?? order.amount,
      currency: order.currency,
      status,
      order_id: orderId,
      method: 'upi',
      amount_refunded: 0,
      refund_status: null,
      captured: status === 'captured',
      error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      error_description: status === 'failed' ? 'Payment failed' : null,
      error_reason: status === 'failed' ? (opts.reason ?? 'payment_failed') : null,
      created_at: Math.floor(this.now().getTime() / 1000),
    };
    this.payments.set(p.id, p);
    return p;
  }
  capture(paymentId: string): FakePayment {
    const p = this.mustPayment(paymentId);
    p.status = 'captured';
    p.captured = true;
    return p;
  }
  /** Someone presses "Refund" in the Razorpay dashboard: a refund our system never asked for. */
  externalRefund(paymentId: string, amount: number): void {
    this.mustPayment(paymentId).amount_refunded += amount;
  }
  settleRefund(refundId: string, outcome: 'processed' | 'failed'): FakeRefund {
    const r = this.refunds.get(refundId);
    if (!r) throw new Error(`fake razorpay: no refund ${refundId}`);
    r.status = outcome;
    if (outcome === 'failed') this.mustPayment(r.payment_id).amount_refunded -= r.amount;
    return r;
  }
  /** Bulk-creates already-captured payments (no order needed) to exercise pagination of the list endpoint. */
  seedCaptured(count: number, atSeconds: number): void {
    for (let i = 0; i < count; i++) {
      const p: FakePayment = { id: id('pay'), entity: 'payment', amount: 1000 + i, currency: 'INR', status: 'captured', order_id: id('order'), method: 'upi', amount_refunded: 0, refund_status: null, captured: true, error_code: null, error_description: null, error_reason: null, created_at: atSeconds };
      this.payments.set(p.id, p);
    }
  }
  inject(fault: keyof FakeRazorpay['faults'], times = 1): void {
    this.faults[fault] += times;
  }
  requestsTo(method: string, pathPrefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  /** A correctly signed webhook, exactly as Razorpay sends it (raw-body HMAC in X-Razorpay-Signature, unique event id header). */
  webhook(event: string, entities: { payment?: FakePayment; refund?: FakeRefund; order?: Order }, eventId = id('evt')): { eventId: string; rawBody: Buffer; headers: Record<string, string> } {
    const payload: Record<string, unknown> = {};
    if (entities.payment) payload['payment'] = { entity: entities.payment };
    if (entities.refund) payload['refund'] = { entity: entities.refund };
    if (entities.order) payload['order'] = { entity: entities.order };
    const rawBody = Buffer.from(JSON.stringify({ entity: 'event', account_id: 'acc_FAKE', event, contains: Object.keys(payload), payload, created_at: Math.floor(this.now().getTime() / 1000) }));
    return { eventId, rawBody, headers: { 'content-type': 'application/json', 'x-razorpay-signature': signRazorpayWebhook(this.creds.webhookSecret, rawBody), 'x-razorpay-event-id': eventId } };
  }

  // ===== the HTTP surface =============================================================================================
  private mustPayment(paymentId: string): FakePayment {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error(`fake razorpay: no payment ${paymentId}`);
    return p;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  private error(res: ServerResponse, status: number, code: string, description: string): void {
    this.send(res, status, { error: { code, description, source: 'NA', step: 'NA', reason: 'NA', metadata: {} } });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const path = url.pathname.replace(/^\/v1/, '');
    this.requests.push({ method: req.method ?? '', path, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    const expected = `Basic ${Buffer.from(`${this.creds.keyId}:${this.creds.keySecret}`).toString('base64')}`;
    if (req.headers.authorization !== expected) return this.error(res, 401, 'BAD_REQUEST_ERROR', 'Authentication failed');

    const m = (re: RegExp) => path.match(re);
    let g: RegExpMatchArray | null;

    if (req.method === 'POST' && path === '/orders') {
      if (this.faults.order500 > 0) {
        this.faults.order500--;
        return this.error(res, 500, 'SERVER_ERROR', 'Something went wrong');
      }
      const amount = body?.['amount'];
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100) return this.error(res, 400, 'BAD_REQUEST_ERROR', 'Order amount less than minimum amount allowed');
      if (body?.['currency'] !== 'INR') return this.error(res, 400, 'BAD_REQUEST_ERROR', 'Currency is not supported');
      const o: Order = { id: id('order'), entity: 'order', amount, amount_paid: 0, amount_due: amount, currency: 'INR', receipt: String(body?.['receipt'] ?? ''), status: 'created', attempts: 0, notes: body?.['notes'] ?? [], created_at: Math.floor(this.now().getTime() / 1000) };
      this.orders.set(o.id, o);
      return this.send(res, 200, o);
    }
    if (req.method === 'GET' && (g = m(/^\/orders\/([^/]+)\/payments$/))) {
      // Verified against the real API: the payments of an order that does not exist are simply an EMPTY collection (HTTP 200).
      const items = [...this.payments.values()].filter((p) => p.order_id === g![1]);
      return this.send(res, 200, { entity: 'collection', count: items.length, items });
    }
    if (req.method === 'GET' && (g = m(/^\/payments\/([^/]+)$/))) {
      const p = this.payments.get(g[1]!);
      return p ? this.send(res, 200, p) : this.error(res, 400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
    }
    if (req.method === 'GET' && path === '/payments') {
      const count = Number(url.searchParams.get('count') ?? 10);
      const skip = Number(url.searchParams.get('skip') ?? 0);
      const from = Number(url.searchParams.get('from') ?? 0);
      const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER);
      if (!(count >= 1 && count <= 100)) return this.error(res, 400, 'BAD_REQUEST_ERROR', 'count must be between 1 and 100');
      const all = [...this.payments.values()].filter((p) => p.created_at >= from && p.created_at <= to).sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)); // newest first
      return this.send(res, 200, { entity: 'collection', count: all.slice(skip, skip + count).length, items: all.slice(skip, skip + count) });
    }
    if (req.method === 'POST' && (g = m(/^\/payments\/([^/]+)\/capture$/))) {
      const p = this.payments.get(g[1]!);
      if (!p) return this.error(res, 400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
      if (p.status !== 'authorized') return this.error(res, 400, 'BAD_REQUEST_ERROR', 'This payment is not in authorized state');
      return this.send(res, 200, this.capture(p.id));
    }
    if (req.method === 'POST' && (g = m(/^\/payments\/([^/]+)\/refund$/))) return this.createRefund(req, res, g[1]!, body);
    if (req.method === 'GET' && (g = m(/^\/refunds\/([^/]+)$/))) {
      const r = this.refunds.get(g[1]!);
      // Verified against the real API: an unknown (valid-format) refund id is HTTP 400 "invalid request sent", not 404.
      return r ? this.send(res, 200, r) : this.error(res, 400, 'BAD_REQUEST_ERROR', 'invalid request sent');
    }
    return this.error(res, 404, 'BAD_REQUEST_ERROR', 'The requested URL was not found on the server.');
  }

  private createRefund(req: IncomingMessage, res: ServerResponse, paymentId: string, body: Record<string, unknown> | null): void {
    if (this.faults.refundGateway404 > 0) {
      // Exactly what Razorpay's API GATEWAY answers when no route matches — NOT an application-level refusal (no `error` object).
      this.faults.refundGateway404--;
      return this.send(res, 404, { message: 'no Route matched with those values' });
    }
    if (this.faults.refund401 > 0) {
      this.faults.refund401--;
      return this.error(res, 401, 'BAD_REQUEST_ERROR', 'Authentication failed');
    }
    if (this.faults.refund500 > 0) {
      this.faults.refund500--;
      return this.error(res, 500, 'SERVER_ERROR', 'Something went wrong');
    }
    if (this.faults.refund409 > 0) {
      this.faults.refund409--;
      return this.error(res, 409, 'BAD_REQUEST_ERROR', 'A request with this idempotency key is already being processed');
    }
    const p = this.payments.get(paymentId);
    if (!p) return this.error(res, 400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');

    const key = req.headers['x-refund-idempotency'];
    const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (typeof key === 'string') {
      if (!/^[A-Za-z0-9_-]{10,}$/.test(key)) return this.error(res, 400, 'BAD_REQUEST_ERROR', 'Idempotency key must be at least 10 characters (alphanumeric, hyphen, underscore)');
      const prior = this.refundKeys.get(key);
      if (prior) {
        if (prior.bodyHash !== bodyHash) return this.error(res, 400, 'BAD_REQUEST_ERROR', 'Request payload differs from the original request for this idempotency key');
        return this.send(res, 200, this.refunds.get(prior.refundId)); // the SAME refund
      }
    }
    if (p.status !== 'captured' && p.status !== 'refunded') return this.error(res, 400, 'BAD_REQUEST_ERROR', 'The payment has not been captured');
    const amount = typeof body?.['amount'] === 'number' ? body['amount'] : p.amount - p.amount_refunded;
    if (!Number.isInteger(amount) || amount <= 0 || amount > p.amount - p.amount_refunded) return this.error(res, 400, 'BAD_REQUEST_ERROR', 'The refund amount provided is greater than the amount available for refund');

    const r: FakeRefund = { id: id('rfnd'), entity: 'refund', amount, currency: p.currency, payment_id: p.id, receipt: typeof body?.['receipt'] === 'string' ? body['receipt'] : null, notes: (body?.['notes'] as Record<string, unknown>) ?? {}, created_at: Math.floor(this.now().getTime() / 1000), status: 'pending', speed_requested: 'normal', speed_processed: 'normal' };
    this.refunds.set(r.id, r);
    p.amount_refunded += amount;
    if (typeof key === 'string') this.refundKeys.set(key, { bodyHash, refundId: r.id });

    if (this.faults.refundDropResponse > 0) {
      // The refund WAS created, but the caller never learns it: the classic "did it go through?" timeout.
      this.faults.refundDropResponse--;
      return void req.socket.destroy();
    }
    this.send(res, 200, r);
  }
}
