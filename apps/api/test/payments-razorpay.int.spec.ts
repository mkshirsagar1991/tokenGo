import { RazorpayPaymentProvider } from '../src/modules/payments';
import { uuidv7 } from '../src/shared-kernel';
import { AdminSession, TestApp, bootTestApp } from './support/app';
import { FakePayment, FakeRazorpay } from './support/fake-razorpay';
import { PaymentsHarness, paymentsHarness } from './support/payments';

const CREDS = { keyId: 'rzp_test_FAKEKEY12345', keySecret: 'test_key_secret_value_1', webhookSecret: 'whsec_test_value_1' };
const RUPEES_500 = 50_000;
const ENV_KEYS = ['PAYMENT_PROVIDER', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_API_BASE_URL'];

/**
 * The payments pipeline driven through Razorpay-shaped traffic. The counterparty is a LOCAL TEST DOUBLE written from Razorpay's
 * published API reference (test/support/fake-razorpay.ts): this proves our requests and handling match the documentation as
 * read, NOT that the real Razorpay behaves identically. It runs in test mode only; no live key is accepted anywhere.
 */
describe('Payments via Razorpay (test mode) against a local test double (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let h: PaymentsHarness;
  let fake: FakeRazorpay;
  let finance: AdminSession;
  let phoneSeq = 9_830_000_000;
  const newCustomer = () => h.newCustomer(String(++phoneSeq));

  const lastOrderId = () => [...fake.orders.keys()].at(-1)!;
  const deliver = (hook: { rawBody: Buffer; headers: Record<string, string> }) => h.webhook(hook, 'razorpay');
  const deliverPayment = (event: string, p: FakePayment, eventId?: string) => deliver(fake.webhook(event, { payment: p }, eventId));
  const refundRequests = () => fake.requestsTo('POST', '/payments/').filter((r) => r.path.endsWith('/refund'));
  const refundRow = (id: string) => h.one<{ status: string; provider_refund_id: string | null; failure_reason: string | null }>('SELECT status, provider_refund_id, failure_reason FROM payments.refunds WHERE id = $1', [id]);
  const requestRefund = (paymentTxId: string, extra: object = {}) =>
    h.adminPost(finance, '/admin/payments/refunds', { payment_transaction_id: paymentTxId, reason: 'Customer asked for the money back', ...extra }, { 'Idempotency-Key': `refund-${uuidv7()}` });

  async function openIntent(amount = RUPEES_500) {
    const c = await newCustomer();
    const res = await h.createIntent(c, amount);
    expect(res.status).toBe(201);
    return { c, intentId: res.body.data.id as string, orderId: lastOrderId(), res };
  }
  /** A paid, webhook-delivered, credited top-up through the Razorpay flow. */
  async function fundViaRazorpay(amount = RUPEES_500) {
    const o = await openIntent(amount);
    const payment = fake.pay(o.orderId);
    expect((await deliverPayment('payment.captured', payment)).body.status).toBe('processed');
    const tx = await h.one<{ id: string }>("SELECT id FROM payments.payment_transactions WHERE intent_id = $1 AND status = 'CAPTURED'", [o.intentId]);
    return { ...o, payment, paymentTxId: tx.id };
  }

  beforeAll(async () => {
    fake = new FakeRazorpay(CREDS, () => t.clock.now());
    await fake.start();
    t = await bootTestApp({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: CREDS.keyId, RAZORPAY_KEY_SECRET: CREDS.keySecret, RAZORPAY_WEBHOOK_SECRET: CREDS.webhookSecret, RAZORPAY_API_BASE_URL: fake.baseUrl });
    h = paymentsHarness(t);
    finance = await t.loginAdmin({ phone: '9700000301', email: 'finance-rzp@example.com', roles: ['FINANCE_OPERATOR'] });
  });
  beforeEach(async () => {
    await h.drain();
  });
  afterAll(async () => {
    await t.close();
    await fake.stop();
    for (const k of ENV_KEYS) delete process.env[k]; // bootTestApp writes to process.env; do not leak into other suites
  });

  // =====================================================================================================
  describe('creating a payment request', () => {
    it('creates a Razorpay order in paise with Basic auth and the intent id as receipt, and exposes only public checkout values', async () => {
      const { intentId, res } = await openIntent();
      const req = fake.requestsTo('POST', '/orders').at(-1)!;
      expect(Buffer.from(req.headers.authorization!.replace('Basic ', ''), 'base64').toString()).toBe(`${CREDS.keyId}:${CREDS.keySecret}`);
      expect(req.body).toEqual({ amount: RUPEES_500, currency: 'INR', receipt: intentId, notes: { intent_id: intentId } });
      expect(typeof req.body!['amount']).toBe('number');

      expect(res.body.data.provider).toBe('razorpay');
      expect(res.body.data.checkout).toEqual({ provider: 'razorpay', key_id: CREDS.keyId, order_id: lastOrderId(), test_mode: true });
      const wire = JSON.stringify(res.body);
      expect(wire).not.toContain(CREDS.keySecret);
      expect(wire).not.toContain(CREDS.webhookSecret);
    });

    it('offers no sandbox shortcuts: the simulator checkout and the sandbox webhook path do not exist', async () => {
      const { c, intentId } = await openIntent();
      expect((await h.pay(c, intentId)).status).toBe(404);
      expect((await deliver(fake.webhook('payment.captured', { payment: fake.pay(lastOrderId()) }))).status).toBe(200);
      const sandboxPath = await h.webhook(fake.webhook('payment.captured', { payment: fake.pay(lastOrderId()) }), 'sandbox');
      expect(sandboxPath.status).toBe(404);
    });

    it('a provider outage while creating the order creates nothing: no intent, no half-made payment request', async () => {
      const c = await newCustomer();
      fake.inject('order500');
      const res = await h.createIntent(c, RUPEES_500);
      expect(res.status).toBe(500);
      expect(await h.count('SELECT count(*) AS n FROM payments.payment_intents WHERE customer_id = $1', [c.userId])).toBe(0);
      expect((await h.createIntent(c, RUPEES_500)).status).toBe(201); // and a retry simply works
    });
  });

  // =====================================================================================================
  describe('top-ups: signed webhooks and server-side verification', () => {
    it('a captured payment + genuine signed webhook credits the wallet exactly once', async () => {
      const { c, intentId, orderId } = await openIntent();
      const payment = fake.pay(orderId);
      const r = await deliverPayment('payment.captured', payment);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('processed');
      expect(await h.available(c)).toBe(RUPEES_500);
      expect((await h.getIntent(c, intentId)).body.data).toMatchObject({ status: 'SUCCEEDED', checkout: null });
      expect(await h.topupTxns(c.userId)).toBe(1);
      expect(fake.requestsTo('GET', `/payments/${payment.id}`)).toHaveLength(1); // the payment was FETCHED, not taken from the webhook
      await h.expectLedgerOk();
    });

    it('CRITICAL TEST #4 with Razorpay semantics: the same event id, 8 simultaneous times, and the same payment under other event ids', async () => {
      const { c, orderId } = await openIntent();
      const payment = fake.pay(orderId);
      const hook = fake.webhook('payment.captured', { payment });
      const results = await Promise.all(Array.from({ length: 8 }, () => deliver(hook)));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(results.filter((r) => r.body.status === 'processed')).toHaveLength(1);

      // Razorpay often also sends order.paid / a re-sent event with a NEW event id for the same payment
      expect((await deliver(fake.webhook('order.paid', { payment, order: fake.orders.get(orderId)! }))).status).toBe(200);
      expect((await deliverPayment('payment.captured', payment)).status).toBe(200);
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await h.topupTxns(c.userId)).toBe(1);
      await h.expectLedgerOk();
    });

    it('rejects a wrong signature, a tampered body, a missing signature and a missing event id — crediting nothing', async () => {
      const { c, intentId, orderId } = await openIntent();
      const payment = fake.pay(orderId);
      const hook = fake.webhook('payment.captured', { payment });

      expect((await deliver({ ...hook, headers: { ...hook.headers, 'x-razorpay-signature': 'a'.repeat(64) } })).status).toBe(401);
      expect((await deliver({ ...hook, rawBody: Buffer.from(hook.rawBody.toString().replace(payment.id, 'pay_somebodyelse')) })).status).toBe(401);
      const { 'x-razorpay-signature': _s, ...noSig } = hook.headers;
      expect((await deliver({ ...hook, headers: noSig })).status).toBe(401);
      const { 'x-razorpay-event-id': _e, ...noEventId } = hook.headers;
      expect((await deliver({ ...hook, headers: noEventId })).status).toBe(401);

      expect(await h.available(c)).toBe(0);
      expect((await h.getIntent(c, intentId)).body.data.status).toBe('PENDING');
      expect((await h.one<{ n: string }>("SELECT count(*) AS n FROM payments.webhook_events WHERE processing_status = 'REJECTED' AND provider_event_id IS NULL AND payload IS NULL")).n).not.toBe('0');
      expect((await deliver(hook)).body.status).toBe('processed'); // the genuine one still goes through
    });

    it('a forged "captured" event for a payment Razorpay never captured credits nothing (the provider is asked, not the body)', async () => {
      const { c, orderId } = await openIntent();
      const real = fake.pay(orderId, { status: 'failed' });
      const lie: FakePayment = { ...real, status: 'captured', captured: true }; // what the (validly signed) body CLAIMS
      expect((await deliverPayment('payment.captured', lie)).status).toBe(200);
      expect(await h.available(c)).toBe(0);
    });

    it('AUTHORIZED is not money: capture is off by default at Razorpay, so nothing is credited until it is captured', async () => {
      const { c, intentId, orderId } = await openIntent();
      const payment = fake.pay(orderId, { status: 'authorized' });

      expect((await deliverPayment('payment.authorized', payment)).body.status).toBe('processed');
      expect((await h.one<{ outcome: string }>("SELECT outcome FROM payments.webhook_events WHERE event_type = 'payment.captured' ORDER BY id DESC LIMIT 1")).outcome).toBe('NOT_FINAL');
      expect(await h.available(c)).toBe(0);
      expect(await h.count('SELECT count(*) AS n FROM payments.payment_transactions WHERE intent_id = $1', [intentId])).toBe(0); // nothing recorded for an undecided payment
      expect((await h.verify(c, intentId)).body.data.status).toBe('PENDING');

      fake.capture(payment.id); // the merchant captures (or auto-capture fires)
      expect((await h.verify(c, intentId)).body.data.status).toBe('SUCCEEDED');
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await h.topupTxns(c.userId)).toBe(1);
    });

    it('a failed attempt is recorded with its reason and leaves the request open for a retry', async () => {
      const { c, intentId, orderId } = await openIntent();
      const failed = fake.pay(orderId, { status: 'failed', reason: 'incorrect_otp' });
      expect((await deliverPayment('payment.failed', failed)).body.status).toBe('processed');
      expect(await h.one("SELECT status, failure_reason FROM payments.payment_transactions WHERE provider_payment_id = $1", [failed.id])).toEqual({ status: 'FAILED', failure_reason: 'incorrect_otp' });
      expect((await h.getIntent(c, intentId)).body.data.status).toBe('PENDING');

      expect((await deliverPayment('payment.captured', fake.pay(orderId))).status).toBe(200);
      expect(await h.available(c)).toBe(RUPEES_500);
    });

    it('a capture for a different amount than requested is quarantined, not credited', async () => {
      const { c, intentId, orderId } = await openIntent();
      const payment = fake.pay(orderId, { amount: RUPEES_500 - 100 });
      await deliverPayment('payment.captured', payment);
      expect(await h.available(c)).toBe(0);
      expect((await h.one<{ status: string }>('SELECT status FROM payments.payment_transactions WHERE intent_id = $1', [intentId])).status).toBe('QUARANTINED');
    });

    it('"verify" asks Razorpay and settles a payment whose webhook never arrived; the customer\'s claim alone does nothing', async () => {
      const { c, intentId, orderId } = await openIntent();
      expect((await h.verify(c, intentId)).body.data.status).toBe('PENDING'); // customer says "I paid" — Razorpay has nothing
      expect(await h.available(c)).toBe(0);
      fake.pay(orderId);
      expect((await h.verify(c, intentId)).body.data.status).toBe('SUCCEEDED');
      expect(await h.available(c)).toBe(RUPEES_500);
    });

    it('the scheduled check settles a lost callback with no customer action', async () => {
      const { c, orderId } = await openIntent();
      fake.pay(orderId);
      t.clock.advanceSeconds(121);
      await h.drain();
      expect(await h.available(c)).toBe(RUPEES_500);
    });

    it('events for an unknown payment id ask Razorpay to retry (503) and are kept, never lost', async () => {
      const ghost = { ...fake.pay(lastOrderId()), id: 'pay_doesNotExist01' };
      const hook = fake.webhook('payment.captured', { payment: ghost });
      expect((await deliver(hook)).status).toBe(503);
      expect(await h.one('SELECT processing_status, attempts FROM payments.webhook_events WHERE provider_event_id = $1', [hook.eventId])).toEqual({ processing_status: 'FAILED', attempts: 1 });
    });
  });

  // =====================================================================================================
  describe('refunds to the original payment method through Razorpay', () => {
    it('sends the refund with OUR refund id as Razorpay\'s idempotency key, then completes on the processed webhook', async () => {
      const { c, paymentTxId, payment } = await fundViaRazorpay();
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      expect(await h.available(c)).toBe(0); // reserved at once
      expect(refundRequests()).toHaveLength(0); // the provider is called after commit

      await h.drain();
      const req = refundRequests().at(-1)!;
      expect(req.path).toBe(`/payments/${payment.id}/refund`);
      expect(req.headers['x-refund-idempotency']).toBe(refundId);
      expect(req.body).toMatchObject({ amount: RUPEES_500, speed: 'normal', notes: { reference: refundId } });
      const sent = await refundRow(refundId);
      expect(sent.status).toBe('PROCESSING');
      expect(sent.provider_refund_id).toMatch(/^rfnd_/);

      const done = fake.settleRefund(sent.provider_refund_id!, 'processed');
      expect((await deliver(fake.webhook('refund.processed', { refund: done, payment }))).body.status).toBe('processed');
      expect((await refundRow(refundId)).status).toBe('SUCCEEDED');
      expect(await h.available(c)).toBe(0);
      await h.expectLedgerOk();
    });

    it('a refund Razorpay reports as failed gives the customer their money back', async () => {
      const { c, paymentTxId, payment } = await fundViaRazorpay();
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await h.drain();
      const failed = fake.settleRefund((await refundRow(refundId)).provider_refund_id!, 'failed');
      await deliver(fake.webhook('refund.failed', { refund: failed, payment }));
      expect(await refundRow(refundId)).toMatchObject({ status: 'FAILED', failure_reason: 'FAILED_AT_PROVIDER' });
      expect(await h.available(c)).toBe(RUPEES_500);
      await h.expectLedgerOk();
    });

    it('CRITICAL TEST #7 (refund leg): Razorpay created the refund but the response was lost — the retry reuses the idempotency key and gets the SAME refund', async () => {
      const { paymentTxId, payment } = await fundViaRazorpay();
      fake.inject('refundDropResponse');
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;

      await h.drain();
      expect((await refundRow(refundId)).status).toBe('PROCESSING');
      expect((await refundRow(refundId)).provider_refund_id).toBeNull(); // we never learned the id...
      expect([...fake.refunds.values()].filter((r) => r.payment_id === payment.id)).toHaveLength(1); // ...but it exists at Razorpay

      t.clock.advanceSeconds(60);
      await h.drain();
      const mine = [...fake.refunds.values()].filter((r) => r.payment_id === payment.id);
      expect(mine).toHaveLength(1); // still ONE refund
      expect((await refundRow(refundId)).provider_refund_id).toBe(mine[0]!.id);
      const keys = refundRequests().filter((r) => r.path.includes(payment.id)).map((r) => r.headers['x-refund-idempotency']);
      expect(keys).toEqual([refundId, refundId]); // the retry carried the very same key
      expect(payment.amount_refunded).toBe(RUPEES_500); // refunded once, not twice
    });

    it.each([
      ['409 (an identical request is still in flight)', 'refund409'],
      ['500 (Razorpay had a problem)', 'refund500'],
    ] as const)('a %s is treated as "try again", never as a refusal', async (_label, fault) => {
      const { c, paymentTxId, payment } = await fundViaRazorpay();
      fake.inject(fault);
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await h.drain();
      expect((await refundRow(refundId)).status).toBe('PROCESSING');
      expect(await h.available(c)).toBe(0); // still reserved, not given back

      t.clock.advanceSeconds(60);
      await h.drain();
      expect((await refundRow(refundId)).provider_refund_id).toMatch(/^rfnd_/);
      expect([...fake.refunds.values()].filter((r) => r.payment_id === payment.id)).toHaveLength(1);
    });

    it('bad credentials (401) are OUR problem, not a refusal: the refund stays pending, the money stays reserved, no secret is stored', async () => {
      const { c, paymentTxId } = await fundViaRazorpay();
      fake.inject('refund401');
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await h.drain();

      expect((await refundRow(refundId)).status).toBe('PROCESSING'); // NOT failed
      expect(await h.available(c)).toBe(0); // NOT handed back while the refund may still go out
      const ev = await h.one<{ status: string; attempts: number; last_error: string }>("SELECT status, attempts, last_error FROM platform.outbox_events WHERE event_type = 'payments.refund_requested' AND aggregate_id = $1", [refundId]);
      expect(ev).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(ev.last_error).toContain('HTTP 401');
      for (const secret of [CREDS.keySecret, CREDS.webhookSecret, Buffer.from(`${CREDS.keyId}:${CREDS.keySecret}`).toString('base64')]) expect(ev.last_error).not.toContain(secret);

      t.clock.advanceSeconds(60);
      await h.drain();
      expect((await refundRow(refundId)).provider_refund_id).toMatch(/^rfnd_/);
    });

    it('a bare gateway 404 ("no Route matched") is NOT a refusal either — verified against the real API, where it is a routing answer, not Razorpay saying no', async () => {
      const { c, paymentTxId } = await fundViaRazorpay();
      fake.inject('refundGateway404');
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await h.drain();
      expect((await refundRow(refundId)).status).toBe('PROCESSING'); // NOT failed
      expect(await h.available(c)).toBe(0); // NOT handed back
      t.clock.advanceSeconds(60);
      await h.drain();
      expect((await refundRow(refundId)).provider_refund_id).toMatch(/^rfnd_/);
    });

    it('a failed or empty STATUS LOOKUP of a refund never returns the customer money: it is retried, whatever Razorpay answers', async () => {
      const { c, paymentTxId } = await fundViaRazorpay();
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await h.drain();
      const providerRefundId = (await refundRow(refundId)).provider_refund_id!;
      fake.refunds.delete(providerRefundId); // the lookup will now answer 400 "invalid request sent" (the real answer for an unknown refund id)

      t.clock.advanceSeconds(6 * 60);
      await h.recovery.sweep();
      expect((await refundRow(refundId)).status).toBe('PROCESSING'); // still pending: not failed, not completed
      expect(await h.available(c)).toBe(0);
      expect(await h.one<{ n: string }>("SELECT count(*) AS n FROM ledger.transactions WHERE txn_type = 'REVERSAL' AND business_ref_id = $1", [refundId])).toEqual({ n: '0' });
      await h.expectLedgerOk();
    });

    it('a definitive 400 from Razorpay (more than is refundable there) fails the refund and returns the money', async () => {
      const { c, paymentTxId, payment } = await fundViaRazorpay();
      fake.externalRefund(payment.id, 30_000); // 30 000 was already refunded in the dashboard, so only 20 000 remains refundable at Razorpay
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await h.drain();
      expect(await refundRow(refundId)).toMatchObject({ status: 'FAILED', failure_reason: 'REJECTED_BY_PROVIDER: BAD_REQUEST_ERROR' });
      expect(await h.available(c)).toBe(RUPEES_500);
      await h.expectLedgerOk();
    });
  });

  // =====================================================================================================
  describe('reconciliation against Razorpay', () => {
    /** Window boundaries on whole seconds: Razorpay timestamps have one-second resolution. */
    const newWindow = () => {
      t.clock.set(new Date(Math.floor(t.clock.now().getTime() / 1000) * 1000 + 7_200_000));
      const from = t.clock.now();
      return { from, to: new Date(from.getTime() + 600_000) };
    };
    const reconcile = (w: { from: Date; to: Date }) => h.adminPost(finance, '/admin/payments/reconciliation', { from: w.from.toISOString(), to: w.to.toISOString() });

    it('lists every page of a large window (Razorpay allows at most 100 per request) without duplicates or gaps', async () => {
      const w = newWindow();
      fake.seedCaptured(230, Math.floor(w.from.getTime() / 1000) + 5);
      const before = fake.requests.length;
      const all = await t.app.get(RazorpayPaymentProvider).listPayments(w);

      expect(all).toHaveLength(230);
      expect(new Set(all.map((p) => p.paymentId)).size).toBe(230);
      const pages = fake.requests.slice(before).filter((r) => r.path === '/payments');
      expect(pages.map((r) => [r.query['count'], r.query['skip']])).toEqual([['100', '0'], ['100', '100'], ['100', '200']]);
      expect(all.map((p) => p.createdAt.getTime())).toEqual([...all.map((p) => p.createdAt.getTime())].sort((a, b) => a - b));
    });

    it('the payments of an order Razorpay does not know are simply none (HTTP 200, empty) — as the real API answers', async () => {
      expect(await t.app.get(RazorpayPaymentProvider).listOrderPayments('order_AbCdEfGhIjKlMn')).toEqual([]);
      expect(await t.app.get(RazorpayPaymentProvider).fetchRefund('rfnd_AbCdEfGhIjKlMn')).toBeNull(); // 400 "invalid request sent"
      expect(await t.app.get(RazorpayPaymentProvider).fetchPayment('pay_AbCdEfGhIjKlMn')).toBeNull(); // 400 "The id provided does not exist"
    });

    it('a clean window matches; a payment with no internal record is MISSING_INTERNAL until it is settled', async () => {
      const w = newWindow();
      await fundViaRazorpay();
      const lost = await openIntent();
      fake.pay(lost.orderId); // captured at Razorpay, callback never delivered
      const first = await reconcile(w);
      expect(first.body.data).toMatchObject({ matched: 1, exceptions: 1 });
      expect(first.body.data.records[0]).toMatchObject({ status: 'MISSING_INTERNAL', actual: { amount_minor: RUPEES_500 } });

      await h.verify(lost.c, lost.intentId);
      expect((await reconcile(w)).body.data).toMatchObject({ matched: 2, exceptions: 0 });
    });

    it('REFUND_MISMATCH: a refund made in the Razorpay dashboard (not by us) is caught; our own refunds are not flagged', async () => {
      const w = newWindow();
      const outside = await fundViaRazorpay();
      fake.externalRefund(outside.payment.id, 10_000); // nobody asked our system for this
      const ours = await fundViaRazorpay(30_000);
      const refundId = (await requestRefund(ours.paymentTxId, { amount_minor: 20_000 })).body.data.id as string;
      await h.drain();
      expect((await refundRow(refundId)).provider_refund_id).toMatch(/^rfnd_/);

      const res = await reconcile(w);
      expect(res.body.data).toMatchObject({ matched: 1, exceptions: 1 });
      expect(res.body.data.records[0]).toMatchObject({ status: 'REFUND_MISMATCH', provider_payment_id: outside.payment.id, expected: { amount_minor: 0 }, actual: { amount_minor: 10_000 } });
    });
  });
});
