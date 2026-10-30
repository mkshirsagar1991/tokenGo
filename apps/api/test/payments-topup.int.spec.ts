import { PaymentIntentService } from '../src/modules/payments/application/payment-intent.service';
import type { ProviderPayment } from '../src/modules/payments';
import { signWebhook } from '../src/modules/payments/domain/webhook-signature';
import { APP_CONFIG, AppConfig, uuidv7 } from '../src/shared-kernel';
import { TestApp, bootTestApp } from './support/app';
import { PaymentsHarness, paymentsHarness } from './support/payments';

const RUPEES_500 = 50_000;

describe('Payments: top-up intents, signed webhooks, recovery (integration, real PostgreSQL, SANDBOX provider)', () => {
  let t: TestApp;
  let h: PaymentsHarness;
  let phoneSeq = 9_800_000_000;
  const newCustomer = () => h.newCustomer(String(++phoneSeq));

  beforeAll(async () => {
    t = await bootTestApp();
    h = paymentsHarness(t);
  });
  afterAll(async () => {
    await t.close();
  });

  // =====================================================================================================
  describe('creating a payment request', () => {
    it('creates a PENDING intent; nothing is credited and the provider holds a matching order', async () => {
      const c = await newCustomer();
      const res = await h.createIntent(c, RUPEES_500);
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(d).toMatchObject({ status: 'PENDING', purpose: 'WALLET_TOPUP', provider: 'sandbox', amount: { amount_minor: RUPEES_500, currency: 'INR' }, succeeded_at: null });
      expect(d.checkout).toMatchObject({ provider: 'sandbox', sandbox: true });
      expect(new Date(d.expires_at).getTime() - t.clock.now().getTime()).toBe(30 * 60_000);

      expect(await h.available(c)).toBe(0);
      expect(await h.topupTxns(c.userId)).toBe(0);
      const order = await h.one<{ amount_minor: string }>('SELECT amount_minor FROM payments.sandbox_orders WHERE provider_order_id = $1', [d.checkout.order_id]);
      expect(order.amount_minor).toBe(String(RUPEES_500));
    });

    it('requires an Idempotency-Key and replays the same intent for a retried request', async () => {
      const c = await newCustomer();
      const a1 = await h.auth(c);
      const noKey = await t.http.post('/api/v1/payments/intents').set(a1).send({ amount_minor: RUPEES_500 });
      expect(noKey.status).toBe(422);

      const first = await h.createIntent(c, RUPEES_500, 'topup-retry-0001');
      const again = await h.createIntent(c, RUPEES_500, 'topup-retry-0001');
      expect(again.status).toBe(first.status);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(await h.count('SELECT count(*) AS n FROM payments.payment_intents WHERE customer_id = $1', [c.userId])).toBe(1);

      const reused = await h.createIntent(c, RUPEES_500 + 100, 'topup-retry-0001');
      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('is idempotent at the service level too (the unique key, not just the HTTP layer)', async () => {
      const c = await newCustomer();
      const svc = t.app.get(PaymentIntentService);
      const key = `svc-${uuidv7()}`;
      const [a, b] = await Promise.all([svc.create(c.userId, { amountMinor: 20_000, idempotencyKey: key }), svc.create(c.userId, { amountMinor: 20_000, idempotencyKey: key })]);
      expect(a.id).toBe(b.id);
      expect(await h.count('SELECT count(*) AS n FROM payments.payment_intents WHERE customer_id = $1', [c.userId])).toBe(1);
    });

    it.each([
      ['below the minimum', 999],
      ['above the maximum', 5_000_001],
    ])('rejects an amount %s with the allowed range, creating nothing', async (_label, amount) => {
      const c = await newCustomer();
      const res = await h.createIntent(c, amount);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('TOPUP_AMOUNT_OUT_OF_RANGE');
      expect(res.body.errors).toMatchObject({ min: { amount_minor: 1000 }, max: { amount_minor: 5_000_000 } });
      expect(await h.count('SELECT count(*) AS n FROM payments.payment_intents WHERE customer_id = $1', [c.userId])).toBe(0);
    });

    it.each([
      ['a fraction of a paisa', { amount_minor: 1000.5 }],
      ['a string', { amount_minor: '1000' }],
      ['zero', { amount_minor: 0 }],
      ['negative', { amount_minor: -5000 }],
      ['a smuggled status', { amount_minor: 5000, status: 'SUCCEEDED' }],
      ['a smuggled credit', { amount_minor: 5000, credited: true }],
      ['a smuggled customer', { amount_minor: 5000, customer_id: uuidv7() }],
      ['no amount', {}],
    ])('rejects %s (the client may only REQUEST an amount)', async (_label, body) => {
      const c = await newCustomer();
      const a2 = await h.auth(c);
      const res = await t.http.post('/api/v1/payments/intents').set(a2).set('Idempotency-Key', `bad-${uuidv7()}`).send(body);
      expect(res.status).toBe(422);
      expect(await h.count('SELECT count(*) AS n FROM payments.payment_intents WHERE customer_id = $1', [c.userId])).toBe(0);
    });

    it('is owner-only: another customer cannot see, verify or pay a payment request (404, not 403)', async () => {
      const owner = await newCustomer();
      const other = await newCustomer();
      const id = (await h.createIntent(owner, RUPEES_500)).body.data.id;
      expect((await h.getIntent(other, id)).status).toBe(404);
      expect((await h.verify(other, id)).status).toBe(404);
      expect((await h.pay(other, id)).status).toBe(404);
      const a3 = await h.auth(other);
      const list = await t.http.get('/api/v1/payments/intents').set(a3);
      expect(list.body.data).toEqual([]);
      expect((await t.http.get(`/api/v1/payments/intents/${id}`)).status).toBe(401);
      expect(await h.available(owner)).toBe(0);
    });

    it('lists the customer\'s own requests newest first with a cursor', async () => {
      const c = await newCustomer();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await h.createIntent(c, 10_000 + i)).body.data.id);
      const a4 = await h.auth(c);
      const p1 = await t.http.get('/api/v1/payments/intents?limit=2').set(a4);
      expect(p1.body.data.map((x: { id: string }) => x.id)).toEqual([ids[2], ids[1]]);
      const p2 = await t.http.get(`/api/v1/payments/intents?limit=2&cursor=${p1.body.meta.next_cursor}`).set(a4);
      expect(p2.body.data.map((x: { id: string }) => x.id)).toEqual([ids[0]]);
      expect(p2.body.meta.next_cursor).toBeNull();
    });
  });

  // =====================================================================================================
  describe('paying: the wallet is credited only after the provider confirms', () => {
    it('success: wallet credited exactly once, intent SUCCEEDED, books balanced, statement labelled', async () => {
      const c = await newCustomer();
      const { intentId, paymentTxId } = await h.fund(c, RUPEES_500);

      expect(await h.available(c)).toBe(RUPEES_500);
      expect((await h.getIntent(c, intentId)).body.data).toMatchObject({ status: 'SUCCEEDED', checkout: null });
      const tx = await h.one<{ status: string; ledger_txn_id: string; amount_minor: string }>('SELECT status, ledger_txn_id, amount_minor FROM payments.payment_transactions WHERE id = $1', [paymentTxId]);
      expect(tx).toMatchObject({ status: 'CAPTURED', amount_minor: String(RUPEES_500) });
      expect(tx.ledger_txn_id).toBeTruthy();
      expect(await h.topupTxns(c.userId)).toBe(1);
      expect(await h.platformBalance(h.PLATFORM_ACCOUNTS.GATEWAY_CLEARING)).toBeGreaterThanOrEqual(RUPEES_500);

      const a5 = await h.auth(c);
      const stmt = await t.http.get('/api/v1/wallet/transactions').set(a5);
      expect(stmt.body.data[0]).toMatchObject({ type: 'TOPUP', label: 'Added to wallet', amount: { amount_minor: RUPEES_500 } });
      const ev = await h.one<{ processing_status: string; outcome: string }>("SELECT processing_status, outcome FROM payments.webhook_events WHERE event_type = 'payment.captured' ORDER BY id DESC LIMIT 1");
      expect(ev).toEqual({ processing_status: 'PROCESSED', outcome: 'CREDITED' });
      expect(await h.auditCount('payment.captured', paymentTxId)).toBe(1);
      await h.expectLedgerOk();
    });

    it('a failed attempt credits nothing and leaves the request open; a retry that succeeds credits once', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id;
      expect((await h.pay(c, id, 'FAILURE')).body.data).toMatchObject({ status: 'FAILED', webhook_delivered: true });
      expect(await h.available(c)).toBe(0);
      expect((await h.getIntent(c, id)).body.data.status).toBe('PENDING');
      expect(await h.count("SELECT count(*) AS n FROM payments.payment_transactions WHERE intent_id = $1 AND status = 'FAILED'", [id])).toBe(1);

      expect((await h.pay(c, id, 'SUCCESS')).status).toBe(200);
      expect(await h.available(c)).toBe(RUPEES_500);
      expect((await h.getIntent(c, id)).body.data.status).toBe('SUCCEEDED');
      expect(await h.topupTxns(c.userId)).toBe(1);
    });

    it('an order can be paid once: a second payment attempt is refused by the provider', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id;
      await h.pay(c, id, 'SUCCESS');
      const again = await h.pay(c, id, 'SUCCESS');
      expect(again.status).toBe(409); // the intent is no longer payable
      expect(await h.available(c)).toBe(RUPEES_500);
    });
  });

  // =====================================================================================================
  describe('CRITICAL TEST #4 — duplicate webhooks never double-credit', () => {
    async function capturedButNotDelivered(amount = RUPEES_500) {
      const c = await newCustomer();
      const id = (await h.createIntent(c, amount)).body.data.id as string;
      const payment = await h.sandbox.simulatePayment({ orderId: await h.orderIdOf(id), outcome: 'SUCCESS' });
      return { c, id, payment };
    }

    it('the same webhook delivered five times in a row credits once; the rest are recognised as duplicates', async () => {
      const { c, payment } = await capturedButNotDelivered();
      const hook = h.sandbox.paymentWebhook(payment);
      const bodies: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await h.webhook(hook);
        expect(r.status).toBe(200);
        bodies.push(r.body.status);
      }
      expect(bodies).toEqual(['processed', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await h.topupTxns(c.userId)).toBe(1);
      expect(await h.count('SELECT count(*) AS n FROM payments.webhook_events WHERE provider_event_id = $1', [hook.eventId])).toBe(1);
      await h.expectLedgerOk();
    });

    it('ten SIMULTANEOUS deliveries of the same event credit exactly once', async () => {
      const { c, payment } = await capturedButNotDelivered();
      const hook = h.sandbox.paymentWebhook(payment);
      const results = await Promise.all(Array.from({ length: 10 }, () => h.webhook(hook)));
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(results.filter((r) => r.body.status === 'processed')).toHaveLength(1);
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await h.topupTxns(c.userId)).toBe(1);
      await h.expectLedgerOk();
    });

    it('the same payment announced under DIFFERENT event ids is credited once (dedupe does not depend on the event id)', async () => {
      const { c, payment } = await capturedButNotDelivered();
      const first = await h.webhook(h.sandbox.paymentWebhook(payment));
      const second = await h.webhook(h.sandbox.paymentWebhook(payment)); // new event id each time
      expect([first.body.status, second.body.status]).toEqual(['processed', 'processed']);
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await h.topupTxns(c.userId)).toBe(1);
      const outcomes = await t.pool.query("SELECT outcome FROM payments.webhook_events WHERE event_type = 'payment.captured' ORDER BY id DESC LIMIT 2");
      expect(outcomes.rows.map((r) => r.outcome).sort()).toEqual(['ALREADY_PROCESSED', 'CREDITED']);
    });

    it('a webhook, a customer "verify", the recovery job and a second webhook racing together still credit once', async () => {
      const { c, id, payment } = await capturedButNotDelivered();
      await Promise.all([
        h.webhook(h.sandbox.paymentWebhook(payment)),
        h.webhook(h.sandbox.paymentWebhook(payment)),
        h.verify(c, id),
        h.recovery.recoverIntent(id, { reschedule: false }),
      ]);
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await h.topupTxns(c.userId)).toBe(1);
      expect(await h.count('SELECT count(*) AS n FROM payments.payment_transactions WHERE intent_id = $1', [id])).toBe(1);
      await h.expectLedgerOk();
    });

    it('a webhook arriving AFTER the payment was already settled by recovery changes nothing', async () => {
      const { c, id, payment } = await capturedButNotDelivered();
      expect((await h.verify(c, id)).body.data.status).toBe('SUCCEEDED');
      const late = await h.webhook(h.sandbox.paymentWebhook(payment));
      expect(late.status).toBe(200);
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await h.topupTxns(c.userId)).toBe(1);
    });

    it('out of order: attempt 2 (captured) is announced before attempt 1 (failed); the result is the same as in order', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      const orderId = await h.orderIdOf(id);
      const failed = await h.sandbox.simulatePayment({ orderId, outcome: 'FAILURE' });
      const captured = await h.sandbox.simulatePayment({ orderId, outcome: 'SUCCESS' });

      expect((await h.webhook(h.sandbox.paymentWebhook(captured))).status).toBe(200);
      expect((await h.webhook(h.sandbox.paymentWebhook(failed))).status).toBe(200);

      expect(await h.available(c)).toBe(RUPEES_500);
      expect((await h.getIntent(c, id)).body.data.status).toBe('SUCCEEDED');
      expect(await h.count("SELECT count(*) AS n FROM payments.payment_transactions WHERE intent_id = $1 AND status = 'CAPTURED'", [id])).toBe(1);
      expect(await h.count("SELECT count(*) AS n FROM payments.payment_transactions WHERE intent_id = $1 AND status = 'FAILED'", [id])).toBe(1);
    });

    it('a "failed" report can never undo a capture we already recorded', async () => {
      const { c, id, payment } = await capturedButNotDelivered();
      await h.webhook(h.sandbox.paymentWebhook(payment));
      const outcome = await h.settlement.applyPayment({ ...payment, status: 'FAILED' } as ProviderPayment);
      expect(outcome).toBe('IGNORED_STALE_FAILURE');
      expect(await h.available(c)).toBe(RUPEES_500);
      expect((await h.getIntent(c, id)).body.data.status).toBe('SUCCEEDED');
    });

    it('a second capture on an already-paid request is credited (the customer WAS charged) and flagged for follow-up', async () => {
      const { c, payment } = await capturedButNotDelivered();
      await h.webhook(h.sandbox.paymentWebhook(payment));
      const second: ProviderPayment = { ...payment, paymentId: `pay_sbx_${uuidv7().replace(/-/g, '')}` };
      expect(await h.settlement.applyPayment(second)).toBe('CREDITED');
      expect(await h.available(c)).toBe(RUPEES_500 * 2);
      const txId = (await h.one<{ id: string }>('SELECT id FROM payments.payment_transactions WHERE provider_payment_id = $1', [second.paymentId])).id;
      expect(await h.auditCount('payment.duplicate_capture_credited', txId)).toBe(1);
      expect(await h.topupTxns(c.userId)).toBe(2);
      await h.expectLedgerOk();
    });
  });

  // =====================================================================================================
  describe('forged, tampered and replayed webhooks are rejected', () => {
    async function openIntent() {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      const orderId = await h.orderIdOf(id);
      return { c, id, orderId };
    }
    /** The classic attack: a well-formed "payment captured" event for an order that was never paid. */
    const forgedCapture = (orderId: string, paymentId = 'pay_sbx_forged') =>
      Buffer.from(JSON.stringify({ id: `evt_forged_${uuidv7()}`, type: 'payment.captured', data: { payment_id: paymentId, order_id: orderId, amount_minor: RUPEES_500, status: 'CAPTURED' } }));

    it('a payment event with a WRONG signature is refused and credits nothing', async () => {
      const { c, id, orderId } = await openIntent();
      const body = forgedCapture(orderId);
      const wrong = signWebhook(Buffer.from('not the provider secret, just a guess..'), Math.floor(t.clock.now().getTime() / 1000), body);
      const r = await h.webhook({ rawBody: body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': wrong } });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      expect(await h.available(c)).toBe(0);
      expect((await h.getIntent(c, id)).body.data.status).toBe('PENDING');
    });

    it('a missing or malformed signature header is refused', async () => {
      const { orderId } = await openIntent();
      const body = forgedCapture(orderId);
      expect((await h.webhook({ rawBody: body, headers: { 'content-type': 'application/json' } })).status).toBe(401);
      expect((await h.webhook({ rawBody: body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': 'v1=abc' } })).status).toBe(401);
    });

    it('a body altered after signing is refused (the signature covers the raw bytes)', async () => {
      const { c, id, orderId } = await openIntent();
      const payment = await h.sandbox.simulatePayment({ orderId, outcome: 'SUCCESS' });
      const genuine = h.sandbox.paymentWebhook(payment);
      const tampered = Buffer.from(genuine.rawBody.toString().replace(payment.paymentId, 'pay_sbx_someone_elses'));
      const r = await h.webhook({ rawBody: tampered, headers: genuine.headers });
      expect(r.status).toBe(401);
      expect(await h.available(c)).toBe(0);
      expect((await h.getIntent(c, id)).body.data.status).toBe('PENDING');
    });

    it('a genuine event replayed with a stale timestamp is refused (bounded replay window)', async () => {
      const { orderId } = await openIntent();
      const payment = await h.sandbox.simulatePayment({ orderId, outcome: 'SUCCESS' });
      const nowSec = Math.floor(t.clock.now().getTime() / 1000);
      const old = h.sandbox.paymentWebhook(payment, { timestampSeconds: nowSec - 301 });
      expect((await h.webhook(old)).status).toBe(401);
      const future = h.sandbox.paymentWebhook(payment, { timestampSeconds: nowSec + 301 });
      expect((await h.webhook(future)).status).toBe(401);
      const ok = h.sandbox.paymentWebhook(payment, { timestampSeconds: nowSec - 299 });
      expect((await h.webhook(ok)).status).toBe(200);
    });

    it('rejected requests are recorded WITHOUT any attacker-supplied field, so they cannot block a real event id', async () => {
      const { c, orderId } = await openIntent();
      const payment = await h.sandbox.simulatePayment({ orderId, outcome: 'SUCCESS' });
      const genuine = h.sandbox.paymentWebhook(payment);

      // the attacker guesses the event id the provider is about to use
      const forged = Buffer.from(JSON.stringify({ id: genuine.eventId, type: 'payment.captured', data: { payment_id: payment.paymentId } }));
      expect((await h.webhook({ rawBody: forged, headers: { 'content-type': 'application/json', 'x-sandbox-signature': `t=${Math.floor(t.clock.now().getTime() / 1000)},v1=${'0'.repeat(64)}` } })).status).toBe(401);

      const row = await h.one<{ provider_event_id: string | null; payload: unknown; processing_status: string; signature_valid: boolean }>("SELECT provider_event_id, payload, processing_status, signature_valid FROM payments.webhook_events WHERE processing_status = 'REJECTED' ORDER BY id DESC LIMIT 1");
      expect(row).toEqual({ provider_event_id: null, payload: null, processing_status: 'REJECTED', signature_valid: false });

      expect((await h.webhook(genuine)).body.status).toBe('processed'); // the real one still goes through
      expect(await h.available(c)).toBe(RUPEES_500);
    });

    it('an unknown provider path is a 404, not an authentication oracle', async () => {
      const { orderId } = await openIntent();
      const payment = await h.sandbox.simulatePayment({ orderId, outcome: 'SUCCESS' });
      expect((await h.webhook(h.sandbox.paymentWebhook(payment), 'stripe')).status).toBe(404);
    });

    it('the webhook BODY is never trusted: a "captured" event for a payment that actually FAILED credits nothing', async () => {
      const { c, id, orderId } = await openIntent();
      const failed = await h.sandbox.simulatePayment({ orderId, outcome: 'FAILURE' });
      const lie = h.sandbox.buildWebhook({ type: 'payment.captured', data: { payment_id: failed.paymentId, order_id: orderId, amount_minor: RUPEES_500, status: 'CAPTURED' } });
      expect((await h.webhook(lie)).status).toBe(200); // authentic envelope, so accepted...
      expect(await h.available(c)).toBe(0); // ...but the provider's own record decides
      expect((await h.getIntent(c, id)).body.data.status).toBe('PENDING');
    });

    it('the amount in the body is ignored: the credit is what the provider actually captured', async () => {
      const { c, orderId } = await openIntent();
      const payment = await h.sandbox.simulatePayment({ orderId, outcome: 'SUCCESS' });
      const inflated = h.sandbox.buildWebhook({ type: 'payment.captured', data: { payment_id: payment.paymentId, order_id: orderId, amount_minor: 99_999_900, status: 'CAPTURED' } });
      expect((await h.webhook(inflated)).status).toBe(200);
      expect(await h.available(c)).toBe(RUPEES_500);
    });

    it('an event for an order that is not ours is acknowledged and ignored, crediting nobody', async () => {
      const orderId = `order_sbx_foreign_${uuidv7().replace(/-/g, '')}`;
      await t.pool.query("INSERT INTO payments.sandbox_orders (provider_order_id, amount_minor, currency, receipt, created_at) VALUES ($1, 5000, 'INR', $2, now())", [orderId, uuidv7()]);
      const payment = await h.sandbox.simulatePayment({ orderId, outcome: 'SUCCESS' });
      const before = await h.count('SELECT count(*) AS n FROM ledger.transactions');
      const r = await h.webhook(h.sandbox.paymentWebhook(payment));
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ignored');
      expect(await h.count('SELECT count(*) AS n FROM ledger.transactions')).toBe(before);
      expect(await h.one("SELECT processing_status, outcome FROM payments.webhook_events WHERE event_type = 'payment.captured' ORDER BY id DESC LIMIT 1")).toEqual({ processing_status: 'IGNORED', outcome: 'unknown order' });
    });

    it('an event naming a payment the provider does not know asks to be retried (503) and is kept as FAILED, never lost', async () => {
      const hook = h.sandbox.buildWebhook({ type: 'payment.captured', data: { payment_id: 'pay_sbx_does_not_exist' } });
      const r = await h.webhook(hook);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('WEBHOOK_PROCESSING_FAILED');
      expect(await h.one('SELECT processing_status, attempts FROM payments.webhook_events WHERE provider_event_id = $1', [hook.eventId])).toEqual({ processing_status: 'FAILED', attempts: 1 });
      // the provider redelivers: the SAME event row is retried (not treated as a duplicate)
      expect((await h.webhook(hook)).status).toBe(503);
      expect(await h.one('SELECT processing_status, attempts FROM payments.webhook_events WHERE provider_event_id = $1', [hook.eventId])).toEqual({ processing_status: 'FAILED', attempts: 2 });
    });

    it('unsupported event types and payloads without ids are acknowledged and ignored', async () => {
      const unsupported = await h.webhook(h.sandbox.buildWebhook({ type: 'dispute.opened', data: { x: 1 } }));
      expect(unsupported.body.status).toBe('ignored');
      const noId = await h.webhook(h.sandbox.buildWebhook({ type: 'payment.captured', data: {} }));
      expect(noId.body.status).toBe('ignored');
    });

    it('a signed-but-malformed envelope is refused rather than half-processed', async () => {
      const body = Buffer.from('{"not":"an envelope"}');
      const ts = Math.floor(t.clock.now().getTime() / 1000);
      const sig = signWebhook(t.app.get<AppConfig>(APP_CONFIG).payments.webhookSecret, ts, body);
      expect((await h.webhook({ rawBody: body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig } })).status).toBe(401);
    });
  });

  // =====================================================================================================
  describe('delayed or lost callbacks are recovered by asking the provider', () => {
    it('"verify" after returning from checkout settles a payment whose webhook never arrived', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      const paid = await h.pay(c, id, 'SUCCESS', { deliver_webhook: false });
      expect(paid.body.data.webhook_delivered).toBe(false);
      expect(await h.available(c)).toBe(0); // nothing is credited on the strength of the customer's claim

      const v1 = await h.verify(c, id);
      expect(v1.body.data.status).toBe('SUCCEEDED');
      expect(await h.available(c)).toBe(RUPEES_500);
      const v2 = await h.verify(c, id);
      expect(v2.body.data.status).toBe('SUCCEEDED');
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await h.topupTxns(c.userId)).toBe(1);
    });

    it('verify on an unpaid request reports PENDING and credits nothing, however often it is called', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      for (let i = 0; i < 3; i++) expect((await h.verify(c, id)).body.data.status).toBe('PENDING');
      expect(await h.available(c)).toBe(0);
    });

    it('the scheduled check (outbox) settles a lost callback with no customer action at all', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      await h.pay(c, id, 'SUCCESS', { deliver_webhook: false });

      await h.drain(); // the first check is not due yet
      expect(await h.available(c)).toBe(0);
      t.clock.advanceSeconds(121);
      await h.drain();
      expect(await h.available(c)).toBe(RUPEES_500);
      expect((await h.getIntent(c, id)).body.data.status).toBe('SUCCEEDED');
      expect(await h.count("SELECT count(*) AS n FROM platform.outbox_events WHERE event_type = 'payments.intent_check' AND aggregate_id = $1 AND status = 'PENDING'", [id])).toBe(0); // chain ended
    });

    it('an unpaid request keeps being re-checked, then EXPIRES at its deadline and the chain stops', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;

      t.clock.advanceSeconds(121);
      await h.drain();
      expect((await h.getIntent(c, id)).body.data.status).toBe('PENDING');
      const next = await h.one<{ attempt: string }>("SELECT payload->>'attempt' AS attempt FROM platform.outbox_events WHERE event_type = 'payments.intent_check' AND aggregate_id = $1 AND status = 'PENDING'", [id]);
      expect(next.attempt).toBe('2');

      for (let i = 0; i < 8; i++) {
        t.clock.advanceSeconds(300);
        await h.drain();
      }
      expect((await h.getIntent(c, id)).body.data.status).toBe('EXPIRED');
      expect(await h.count("SELECT count(*) AS n FROM platform.outbox_events WHERE event_type = 'payments.intent_check' AND aggregate_id = $1 AND status = 'PENDING'", [id])).toBe(0);
      expect(await h.auditCount('payment_intent.expired', id)).toBe(1);
      expect(await h.available(c)).toBe(0);
    });

    it('money captured AFTER the request expired is still credited — the books follow reality', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      const orderId = await h.orderIdOf(id);
      for (let i = 0; i < 8; i++) {
        t.clock.advanceSeconds(300);
        await h.drain();
      }
      expect((await h.getIntent(c, id)).body.data.status).toBe('EXPIRED');

      const payment = await h.sandbox.simulatePayment({ orderId, outcome: 'SUCCESS' }); // the customer paid at the last moment
      expect((await h.webhook(h.sandbox.paymentWebhook(payment))).body.status).toBe('processed');

      expect(await h.available(c)).toBe(RUPEES_500);
      expect((await h.getIntent(c, id)).body.data.status).toBe('SUCCEEDED');
      const txId = (await h.one<{ id: string }>('SELECT id FROM payments.payment_transactions WHERE provider_payment_id = $1', [payment.paymentId])).id;
      expect(await h.auditCount('payment.late_capture_credited', txId)).toBe(1);
    });

    it('the worker\'s sweeper settles a payment even when the per-intent check chain was lost', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      await h.pay(c, id, 'SUCCESS', { deliver_webhook: false });
      await t.pool.query("DELETE FROM platform.outbox_events WHERE event_type = 'payments.intent_check' AND aggregate_id = $1", [id]);

      expect((await h.recovery.sweep()).intents).toBeGreaterThanOrEqual(0);
      expect(await h.available(c)).toBe(0); // too young: the sweeper never races a normal callback

      t.clock.advanceSeconds(6 * 60);
      const swept = await h.recovery.sweep();
      expect(swept.intents).toBeGreaterThanOrEqual(1);
      expect(await h.available(c)).toBe(RUPEES_500);
    });

    it('forged-webhook rows are trimmed by the sweeper after the retention period; genuine events are kept', async () => {
      await h.webhook({ rawBody: Buffer.from('{}'), headers: { 'content-type': 'application/json', 'x-sandbox-signature': 'nope' } });
      const genuine = await h.count("SELECT count(*) AS n FROM payments.webhook_events WHERE signature_valid");
      t.clock.advanceSeconds(15 * 86_400);
      const swept = await h.recovery.sweep();
      expect(swept.purgedWebhooks).toBeGreaterThanOrEqual(1);
      expect(await h.count("SELECT count(*) AS n FROM payments.webhook_events WHERE processing_status = 'REJECTED'")).toBe(0);
      expect(await h.count("SELECT count(*) AS n FROM payments.webhook_events WHERE signature_valid")).toBe(genuine);
    });
  });

  // =====================================================================================================
  describe('amount mismatch is quarantined, never guessed at', () => {
    it('a capture for a different amount than requested credits nothing and is flagged loudly', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      const paid = await h.pay(c, id, 'SUCCESS', { amount_minor: RUPEES_500 - 100 });
      expect(paid.status).toBe(200);

      expect(await h.available(c)).toBe(0);
      expect((await h.getIntent(c, id)).body.data.status).toBe('PENDING');
      const tx = await h.one<{ id: string; status: string; ledger_txn_id: string | null; failure_reason: string }>("SELECT id, status, ledger_txn_id, failure_reason FROM payments.payment_transactions WHERE intent_id = $1", [id]);
      expect(tx.status).toBe('QUARANTINED');
      expect(tx.ledger_txn_id).toBeNull();
      expect(tx.failure_reason).toContain('AMOUNT_MISMATCH');
      expect(await h.auditCount('payment.quarantined', tx.id)).toBe(1);
      expect(await h.count("SELECT count(*) AS n FROM platform.outbox_events WHERE event_type = 'payments.payment_quarantined' AND aggregate_id = $1", [tx.id])).toBe(1);

      // re-delivery / recovery do not turn it into a credit
      await h.verify(c, id);
      await h.recovery.recoverIntent(id, { reschedule: false });
      expect(await h.available(c)).toBe(0);
      expect(await h.count('SELECT count(*) AS n FROM payments.payment_transactions WHERE intent_id = $1', [id])).toBe(1);
    });

    it('the database itself refuses a CAPTURED payment that has no ledger transaction', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      await expect(
        t.pool.query(
          "INSERT INTO payments.payment_transactions (id, intent_id, provider, provider_payment_id, status, amount_minor, currency, ledger_txn_id, provider_created_at, verified_at) VALUES ($1, $2, 'sandbox', 'pay_x', 'CAPTURED', 100, 'INR', NULL, now(), now())",
          [uuidv7(), id],
        ),
      ).rejects.toMatchObject({ constraint: 'payment_transactions_captured_has_ledger' });
    });
  });
});
