import { RefundService } from '../src/modules/payments/application/refund.service';
import { ProviderRejectedError } from '../src/modules/payments/domain/payment-provider';
import { Money, uuidv7 } from '../src/shared-kernel';
import { AdminSession, TestApp, bootTestApp } from './support/app';
import { PaymentsHarness, paymentsHarness } from './support/payments';

const RUPEES_500 = 50_000;
const SYS = { type: 'SYSTEM' as const };

describe('Payments: refunds to the original instrument, reconciliation, authorization (integration, real PostgreSQL, SANDBOX provider)', () => {
  let t: TestApp;
  let h: PaymentsHarness;
  let finance: AdminSession;
  let support: AdminSession;
  let phoneSeq = 9_810_000_000;
  const newCustomer = () => h.newCustomer(String(++phoneSeq));

  const refundBody = (paymentTransactionId: string, extra: object = {}) => ({ payment_transaction_id: paymentTransactionId, reason: 'Customer asked for the money back', ...extra });
  const requestRefund = (paymentTransactionId: string, extra: object = {}, key = `refund-${uuidv7()}`) => h.adminPost(finance, '/admin/payments/refunds', refundBody(paymentTransactionId, extra), { 'Idempotency-Key': key });
  const refundRow = (id: string) => h.one<{ status: string; provider_refund_id: string | null; failure_reason: string | null; reserve_txn_id: string | null; close_txn_id: string | null }>('SELECT status, provider_refund_id, failure_reason, reserve_txn_id, close_txn_id FROM payments.refunds WHERE id = $1', [id]);
  const sandboxRefunds = (providerPaymentId: string) => h.count('SELECT count(*) AS n FROM payments.sandbox_refunds WHERE provider_payment_id = $1', [providerPaymentId]);
  /** Every ledger transaction of the customer's wallet, plus the refund postings that only touch platform accounts. */
  const txnTypes = async (customerId: string) =>
    (
      await t.pool.query(
        `SELECT t.txn_type FROM ledger.transactions t
          WHERE t.id IN (
                  SELECT e.txn_id FROM ledger.entries e JOIN ledger.wallet_accounts w ON w.available_account_id = e.account_id WHERE w.customer_id = $1
                  UNION
                  SELECT t2.id FROM ledger.transactions t2 JOIN payments.refunds r ON r.id = t2.business_ref_id WHERE t2.business_ref_type = 'refund' AND r.customer_id = $1)
          ORDER BY t.id`,
        [customerId],
      )
    ).rows.map((r) => r.txn_type as string);
  const clearing = (name: 'REFUND_CLEARING' | 'GATEWAY_CLEARING') => h.platformBalance(h.PLATFORM_ACCOUNTS[name]);

  /** Funds a customer by a real top-up and returns what is needed to refund it. */
  async function fundedCustomer(amount = RUPEES_500) {
    const c = await newCustomer();
    return { c, ...(await h.fund(c, amount)) };
  }

  beforeAll(async () => {
    t = await bootTestApp();
    h = paymentsHarness(t);
    finance = await t.loginAdmin({ phone: '9700000201', email: 'finance@example.com', roles: ['FINANCE_OPERATOR'] });
    support = await t.loginAdmin({ phone: '9700000202', email: 'support@example.com', roles: ['SUPPORT_OPERATOR'] });
  });
  beforeEach(async () => {
    await h.drain(); // no leftover outbox events from an earlier test may be consumed (or spied on) by this one
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await t.close();
  });

  // =====================================================================================================
  describe('the refund journey', () => {
    it('request -> money parked at once -> provider accepts -> provider confirms -> done, with the books balanced at every step', async () => {
      const gatewayBefore = await clearing('GATEWAY_CLEARING');
      const refundClearingBefore = await clearing('REFUND_CLEARING');
      const { c, paymentTxId, providerPaymentId } = await fundedCustomer();
      expect(await clearing('GATEWAY_CLEARING')).toBe(gatewayBefore + RUPEES_500);

      const res = await requestRefund(paymentTxId);
      expect(res.status).toBe(201);
      const refundId = res.body.data.id as string;
      expect(res.body.data).toMatchObject({ status: 'PROCESSING', amount: { amount_minor: RUPEES_500, currency: 'INR' }, payment_transaction_id: paymentTxId });
      // The money leaves the wallet immediately and waits in REFUND_CLEARING: it cannot be spent while the refund is in flight.
      expect(await h.available(c)).toBe(0);
      expect(await clearing('REFUND_CLEARING')).toBe(refundClearingBefore + RUPEES_500);
      expect(await sandboxRefunds(providerPaymentId)).toBe(0); // the provider is called AFTER commit, by the worker

      await h.drain();
      const afterSubmit = await refundRow(refundId);
      expect(afterSubmit.status).toBe('PROCESSING');
      expect(afterSubmit.provider_refund_id).toMatch(/^rfnd_sbx_/);
      expect(await sandboxRefunds(providerPaymentId)).toBe(1);

      const processed = await h.sandbox.settleRefund(afterSubmit.provider_refund_id!, 'PROCESSED');
      expect((await h.webhook(h.sandbox.refundWebhook(processed))).body.status).toBe('processed');

      const done = await refundRow(refundId);
      expect(done.status).toBe('SUCCEEDED');
      expect(done.close_txn_id).toBeTruthy();
      expect(await clearing('REFUND_CLEARING')).toBe(refundClearingBefore); // fully drained
      expect(await clearing('GATEWAY_CLEARING')).toBe(gatewayBefore); // the money has left the platform again
      expect(await h.available(c)).toBe(0);
      expect(await txnTypes(c.userId)).toEqual(['TOPUP', 'REFUND_RESERVE', 'REFUND_COMPLETE']);
      expect(await h.auditCount('refund.requested', refundId)).toBe(1);
      expect(await h.auditCount('refund.succeeded', refundId)).toBe(1);

      const stmt = await (async () => {
        const a = await h.auth(c);
        return t.http.get('/api/v1/wallet/transactions').set(a);
      })();
      expect(stmt.body.data.map((x: { label: string }) => x.label)).toEqual(expect.arrayContaining(['Added to wallet', 'Refund to your original payment method']));
      await h.expectLedgerOk();
    });

    it('the provider reports success before we even submitted (webhook first): completed once, the later submit is a no-op', async () => {
      const { c, paymentTxId, providerPaymentId } = await fundedCustomer();
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      // the provider already has it (our submit "crashed" after the provider accepted) and has finished it
      const pr = await h.sandbox.createRefund({ paymentId: providerPaymentId, amountMinor: BigInt(RUPEES_500), idempotencyKey: refundId });
      const settled = await h.sandbox.settleRefund(pr.refundId, 'PROCESSED');
      expect((await h.webhook(h.sandbox.refundWebhook(settled))).body.status).toBe('processed');
      expect((await refundRow(refundId)).status).toBe('SUCCEEDED');

      await h.drain(); // our own delayed submit now runs
      expect(await sandboxRefunds(providerPaymentId)).toBe(1);
      expect((await txnTypes(c.userId)).filter((x) => x === 'REFUND_COMPLETE')).toHaveLength(1);
      await h.expectLedgerOk();
    });

    it('duplicate refund webhooks complete the refund once', async () => {
      const { c, paymentTxId } = await fundedCustomer();
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await h.drain();
      const pr = await h.sandbox.settleRefund((await refundRow(refundId)).provider_refund_id!, 'PROCESSED');
      const hook = h.sandbox.refundWebhook(pr);
      const results = await Promise.all([h.webhook(hook), h.webhook(hook), h.webhook(h.sandbox.refundWebhook(pr)), h.webhook(hook)]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect((await txnTypes(c.userId)).filter((x) => x === 'REFUND_COMPLETE')).toHaveLength(1);
      expect((await refundRow(refundId)).status).toBe('SUCCEEDED');
      await h.expectLedgerOk();
    });

    it('the provider refuses: the customer is made whole by a COMPENSATING entry (history is never edited)', async () => {
      const refundClearingBefore = await clearing('REFUND_CLEARING');
      const { c, paymentTxId } = await fundedCustomer();
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      expect(await h.available(c)).toBe(0);
      await h.drain();
      const failed = await h.sandbox.settleRefund((await refundRow(refundId)).provider_refund_id!, 'FAILED');
      expect((await h.webhook(h.sandbox.refundWebhook(failed))).body.status).toBe('processed');

      const row = await refundRow(refundId);
      expect(row).toMatchObject({ status: 'FAILED', failure_reason: 'FAILED_AT_PROVIDER' });
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await clearing('REFUND_CLEARING')).toBe(refundClearingBefore);
      expect(await txnTypes(c.userId)).toEqual(['TOPUP', 'REFUND_RESERVE', 'REVERSAL']);
      expect(await h.auditCount('refund.failed', refundId)).toBe(1);

      // a failed refund frees the amount again: it can be requested anew
      expect((await requestRefund(paymentTxId)).status).toBe(201);
      await h.expectLedgerOk();
    });
  });

  // =====================================================================================================
  describe('limits: never refund more than was paid, or money that is gone', () => {
    it('partial refunds add up to at most the payment; the next one is refused with what remains', async () => {
      const { paymentTxId } = await fundedCustomer();
      expect((await requestRefund(paymentTxId, { amount_minor: 20_000 })).status).toBe(201);
      expect((await requestRefund(paymentTxId, { amount_minor: 30_000 })).status).toBe(201);
      const over = await requestRefund(paymentTxId, { amount_minor: 1 });
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('REFUND_EXCEEDS_PAYMENT');
      expect(over.body.errors.refundable).toEqual({ amount_minor: 0, currency: 'INR' });
    });

    it('more than the payment is refused outright; omitting the amount refunds everything that remains', async () => {
      const { paymentTxId } = await fundedCustomer();
      const tooMuch = await requestRefund(paymentTxId, { amount_minor: RUPEES_500 + 1 });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.errors.refundable.amount_minor).toBe(RUPEES_500);
      expect((await requestRefund(paymentTxId, { amount_minor: 10_000 })).status).toBe(201);
      const rest = await requestRefund(paymentTxId);
      expect(rest.status).toBe(201);
      expect(rest.body.data.amount.amount_minor).toBe(RUPEES_500 - 10_000);
    });

    it('two simultaneous full refunds of one payment: exactly one is accepted', async () => {
      const { c, paymentTxId } = await fundedCustomer();
      await h.adminAuth(finance); // refresh the token first: two concurrent re-logins would fight over one TOTP step
      const [a, b] = await Promise.all([requestRefund(paymentTxId), requestRefund(paymentTxId)]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      expect(await h.count("SELECT count(*) AS n FROM payments.refunds WHERE payment_transaction_id = $1 AND status <> 'FAILED'", [paymentTxId])).toBe(1);
      expect(await h.available(c)).toBe(0);
      await h.expectLedgerOk();
    });

    it('money the customer already spent cannot be refunded: refused cleanly, nothing reserved, nothing promised', async () => {
      const { c, paymentTxId } = await fundedCustomer();
      await h.ledger.createHold({ bookingId: uuidv7(), customerId: c.userId, amount: Money.of(40_000n, 'INR'), idempotencyKey: `hold:${uuidv7()}`, actor: SYS });
      expect(await h.available(c)).toBe(10_000);

      const res = await requestRefund(paymentTxId); // wants 50 000, only 10 000 is free
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REFUND_FUNDS_ALREADY_SPENT');
      expect(res.body.errors.shortfall.amount_minor).toBe(40_000);
      expect(await h.count('SELECT count(*) AS n FROM payments.refunds WHERE payment_transaction_id = $1', [paymentTxId])).toBe(0);
      expect(await h.available(c)).toBe(10_000);
      expect(await h.held(c)).toBe(40_000);

      expect((await requestRefund(paymentTxId, { amount_minor: 10_000 })).status).toBe(201); // what is free can go back
      await h.expectLedgerOk();
    });

    it('only a captured payment is refundable (failed and quarantined ones are refused; unknown ids are 404)', async () => {
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      await h.pay(c, id, 'FAILURE');
      const failedTx = (await h.one<{ id: string }>("SELECT id FROM payments.payment_transactions WHERE intent_id = $1 AND status = 'FAILED'", [id])).id;
      expect((await requestRefund(failedTx)).body.code).toBe('PAYMENT_NOT_REFUNDABLE');

      const id2 = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      await h.pay(c, id2, 'SUCCESS', { amount_minor: RUPEES_500 - 100 });
      const quarantinedTx = (await h.one<{ id: string }>("SELECT id FROM payments.payment_transactions WHERE intent_id = $1 AND status = 'QUARANTINED'", [id2])).id;
      const q = await requestRefund(quarantinedTx);
      expect(q.status).toBe(409);
      expect(q.body.code).toBe('PAYMENT_NOT_REFUNDABLE');

      expect((await requestRefund(uuidv7())).status).toBe(404);
    });

    it.each([
      ['no reason', { reason: '' }],
      ['a one-word reason', { reason: 'ok' }],
      ['a fractional amount', { amount_minor: 100.5 }],
      ['zero', { amount_minor: 0 }],
      ['an unknown field', { status: 'SUCCEEDED' }],
    ])('rejects %s', async (_l, extra) => {
      const { paymentTxId } = await fundedCustomer();
      const res = await h.adminPost(finance, '/admin/payments/refunds', { ...refundBody(paymentTxId), ...extra }, { 'Idempotency-Key': `refund-${uuidv7()}` });
      expect(res.status).toBe(422);
      expect(await h.count('SELECT count(*) AS n FROM payments.refunds WHERE payment_transaction_id = $1', [paymentTxId])).toBe(0);
    });
  });

  // =====================================================================================================
  describe('idempotency and the provider call (query-before-retry)', () => {
    it('a retried refund request returns the same refund and reserves the money once', async () => {
      const { c, paymentTxId } = await fundedCustomer();
      const before = await clearing('REFUND_CLEARING');
      const first = await requestRefund(paymentTxId, { amount_minor: 20_000 }, 'refund-retry-0001');
      const again = await requestRefund(paymentTxId, { amount_minor: 20_000 }, 'refund-retry-0001');
      expect(first.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(await clearing('REFUND_CLEARING')).toBe(before + 20_000);
      expect(await h.available(c)).toBe(30_000);

      const reused = await requestRefund(paymentTxId, { amount_minor: 25_000 }, 'refund-retry-0001');
      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const noKey = await h.adminPost(finance, '/admin/payments/refunds', refundBody(paymentTxId));
      expect(noKey.status).toBe(422);
    });

    it('the service is idempotent on its own key too', async () => {
      const { paymentTxId } = await fundedCustomer();
      const svc = t.app.get(RefundService);
      const input = { paymentTransactionId: paymentTxId, amountMinor: 10_000, reason: 'service-level retry', idempotencyKey: `svc-${uuidv7()}`, actorId: finance.userId };
      const a = await svc.create(input);
      const b = await svc.create(input);
      expect(b.id).toBe(a.id);
      expect(await h.count('SELECT count(*) AS n FROM payments.refunds WHERE payment_transaction_id = $1', [paymentTxId])).toBe(1);
    });

    it('a network failure calling the provider is retried with backoff and the provider ends up with ONE refund', async () => {
      const { paymentTxId, providerPaymentId } = await fundedCustomer();
      const spy = jest.spyOn(h.sandbox, 'createRefund').mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;

      await h.drain();
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await refundRow(refundId)).status).toBe('PROCESSING');
      expect(await sandboxRefunds(providerPaymentId)).toBe(0);
      const ev = await h.one<{ status: string; attempts: number }>("SELECT status, attempts FROM platform.outbox_events WHERE event_type = 'payments.refund_requested' AND aggregate_id = $1", [refundId]);
      expect(ev).toEqual({ status: 'PENDING', attempts: 1 }); // parked for a retry, not lost, not dead-lettered

      t.clock.advanceSeconds(60);
      await h.drain();
      expect(await sandboxRefunds(providerPaymentId)).toBe(1);
      expect((await refundRow(refundId)).provider_refund_id).toMatch(/^rfnd_sbx_/);
    });

    it('CRITICAL TEST #7 (refund leg): the provider accepted but we crashed before recording it — the retry finds that refund instead of creating another', async () => {
      const { c, paymentTxId, providerPaymentId } = await fundedCustomer();
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      const accepted = await h.sandbox.createRefund({ paymentId: providerPaymentId, amountMinor: BigInt(RUPEES_500), idempotencyKey: refundId }); // happened, then the process died

      await h.drain();
      expect(await sandboxRefunds(providerPaymentId)).toBe(1);
      expect((await refundRow(refundId)).provider_refund_id).toBe(accepted.refundId);

      // and a second retry (the sweeper) after that is just a status query
      t.clock.advanceSeconds(6 * 60);
      await h.recovery.sweep();
      expect(await sandboxRefunds(providerPaymentId)).toBe(1);
      expect(await h.available(c)).toBe(0);
      await h.expectLedgerOk();
    });

    it('a definitive refusal from the provider fails the refund and returns the money to the customer', async () => {
      const { c, paymentTxId } = await fundedCustomer();
      jest.spyOn(h.sandbox, 'createRefund').mockRejectedValueOnce(new ProviderRejectedError('ACCOUNT_CLOSED', 'The original account is closed'));
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await h.drain();

      expect(await refundRow(refundId)).toMatchObject({ status: 'FAILED', failure_reason: 'REJECTED_BY_PROVIDER: ACCOUNT_CLOSED' });
      expect(await h.available(c)).toBe(RUPEES_500);
      expect(await txnTypes(c.userId)).toEqual(['TOPUP', 'REFUND_RESERVE', 'REVERSAL']);
      await h.expectLedgerOk();
    });

    it('the sweeper submits a refund whose outbox event was lost, and finishes one the provider already completed', async () => {
      const { paymentTxId, providerPaymentId } = await fundedCustomer();
      const refundId = (await requestRefund(paymentTxId)).body.data.id as string;
      await t.pool.query("DELETE FROM platform.outbox_events WHERE event_type = 'payments.refund_requested' AND aggregate_id = $1", [refundId]);

      t.clock.advanceSeconds(6 * 60);
      await h.recovery.sweep(); // submits; the provider now holds it PENDING
      expect(await sandboxRefunds(providerPaymentId)).toBe(1);
      expect((await refundRow(refundId)).status).toBe('PROCESSING');

      await h.sandbox.settleRefund((await refundRow(refundId)).provider_refund_id!, 'PROCESSED'); // webhook never arrives
      await h.recovery.sweep();
      expect((await refundRow(refundId)).status).toBe('SUCCEEDED');
      await h.expectLedgerOk();
    });
  });

  // =====================================================================================================
  describe('authorization', () => {
    it('only finance can refund or reconcile; support can look; customers and anonymous callers get nothing', async () => {
      const { c, paymentTxId } = await fundedCustomer();
      const cust = await h.auth(c);

      for (const [method, path] of [['post', '/admin/payments/refunds'], ['post', '/admin/payments/reconciliation'], ['get', '/admin/payments/transactions'], ['get', '/admin/payments/webhook-events'], ['get', '/admin/payments/refunds']] as const) {
        expect((await t.http[method](`/api/v1${path}`).set(cust).set('Idempotency-Key', `k-${uuidv7()}`).send({})).status).toBe(403);
        expect((await t.http[method](`/api/v1${path}`).send({})).status).toBe(401);
      }

      expect((await h.adminGet(support, '/admin/payments/transactions')).status).toBe(200);
      expect((await h.adminGet(support, '/admin/payments/webhook-events')).status).toBe(200);
      expect((await requestRefundAs(support, paymentTxId)).status).toBe(403);
      expect((await h.adminPost(support, '/admin/payments/reconciliation', { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })).status).toBe(403);
      expect(await h.count('SELECT count(*) AS n FROM payments.refunds WHERE payment_transaction_id = $1', [paymentTxId])).toBe(0);

      expect((await requestRefund(paymentTxId)).status).toBe(201);
    });

    function requestRefundAs(admin: AdminSession, paymentTxId: string) {
      return h.adminPost(admin, '/admin/payments/refunds', refundBody(paymentTxId), { 'Idempotency-Key': `refund-${uuidv7()}` });
    }

    it('finance can read refunds back, newest first, and filter them', async () => {
      const { paymentTxId } = await fundedCustomer();
      const r1 = (await requestRefund(paymentTxId, { amount_minor: 10_000 })).body.data.id as string;
      const r2 = (await requestRefund(paymentTxId, { amount_minor: 20_000 })).body.data.id as string;
      const list = await h.adminGet(finance, `/admin/payments/refunds?payment_transaction_id=${paymentTxId}`);
      expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([r2, r1]);
      expect((await h.adminGet(finance, `/admin/payments/refunds/${r1}`)).body.data).toMatchObject({ id: r1, status: 'PROCESSING' });
      expect((await h.adminGet(finance, '/admin/payments/refunds/not-a-uuid')).status).toBe(404);
      expect((await h.adminGet(finance, `/admin/payments/refunds/${uuidv7()}`)).status).toBe(404);
    });

    it('the payment and webhook views carry ids and states only — no payloads, no personal data', async () => {
      const { c } = await fundedCustomer();
      await h.webhook({ rawBody: Buffer.from('{}'), headers: { 'content-type': 'application/json', 'x-sandbox-signature': 'bad' } });

      const tx = await h.adminGet(finance, `/admin/payments/transactions?customer_id=${c.userId}`);
      expect(tx.status).toBe(200);
      expect(tx.body.data).toHaveLength(1);
      expect(Object.keys(tx.body.data[0]).sort()).toEqual(['amount', 'created_at', 'customer_id', 'failure_reason', 'id', 'intent_id', 'ledger_txn_id', 'provider', 'provider_payment_id', 'status']);

      const ev = await h.adminGet(finance, '/admin/payments/webhook-events?status=REJECTED');
      expect(ev.body.data.length).toBeGreaterThanOrEqual(1);
      expect(ev.body.data[0]).toMatchObject({ signature_valid: false, status: 'REJECTED', provider_event_id: null });
      expect(ev.body.data[0]).not.toHaveProperty('payload');

      const q = await h.adminGet(finance, '/admin/payments/transactions?status=QUARANTINED');
      expect(q.status).toBe(200);
      expect((await h.adminGet(finance, '/admin/payments/transactions?status=BOGUS')).status).toBe(422);
    });
  });

  // =====================================================================================================
  describe('reconciliation against the provider\'s records', () => {
    const iso = (d: Date) => d.toISOString();
    /** A clean window: nothing from earlier tests can fall inside it. */
    const newWindow = () => {
      t.clock.advanceSeconds(7_200);
      const from = t.clock.now();
      return { from, to: new Date(from.getTime() + 600_000) };
    };
    const reconcile = (w: { from: Date; to: Date }) => h.adminPost(finance, '/admin/payments/reconciliation', { from: iso(w.from), to: iso(w.to) });

    it('a clean period matches everything and persists the run', async () => {
      const w = newWindow();
      await fundedCustomer();
      await fundedCustomer(30_000);
      const res = await reconcile(w);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ matched: 2, exceptions: 0, records: [], provider: 'sandbox' });

      const stored = await h.adminGet(finance, `/admin/payments/reconciliation/${res.body.data.id}`);
      expect(stored.body.data).toMatchObject({ id: res.body.data.id, matched: 2, exceptions: 0 });
      expect(await h.auditCount('payments.reconciliation_run', res.body.data.id)).toBe(1);
    });

    it('MISSING_INTERNAL: the provider took money we have no record of — and it disappears once we settle it', async () => {
      const w = newWindow();
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      const lost = await h.sandbox.simulatePayment({ orderId: await h.orderIdOf(id), outcome: 'SUCCESS' }); // the callback never came

      const first = await reconcile(w);
      expect(first.body.data.exceptions).toBe(1);
      expect(first.body.data.records[0]).toMatchObject({ status: 'MISSING_INTERNAL', provider_payment_id: lost.paymentId, expected: null, actual: { amount_minor: RUPEES_500 } });

      await h.verify(c, id);
      const second = await reconcile(w);
      expect(second.body.data).toMatchObject({ matched: 1, exceptions: 0 });
    });

    it('MISSING_EXTERNAL: we recorded a capture the provider does not list', async () => {
      const w = newWindow();
      const { providerPaymentId } = await fundedCustomer();
      await t.pool.query('DELETE FROM payments.sandbox_payments WHERE provider_payment_id = $1', [providerPaymentId]);
      const res = await reconcile(w);
      expect(res.body.data.records).toEqual([expect.objectContaining({ status: 'MISSING_EXTERNAL', provider_payment_id: providerPaymentId, actual: null, expected: { amount_minor: RUPEES_500, currency: 'INR' } })]);
    });

    it('AMOUNT_MISMATCH: a quarantined payment is surfaced (expected vs. what the provider took)', async () => {
      const w = newWindow();
      const c = await newCustomer();
      const id = (await h.createIntent(c, RUPEES_500)).body.data.id as string;
      await h.pay(c, id, 'SUCCESS', { amount_minor: RUPEES_500 - 100 });
      const res = await reconcile(w);
      expect(res.body.data.records).toEqual([expect.objectContaining({ status: 'AMOUNT_MISMATCH', expected: { amount_minor: RUPEES_500, currency: 'INR' }, actual: { amount_minor: RUPEES_500 - 100, currency: 'INR' } })]);
      expect(res.body.data.records[0].detail).toContain('quarantined');
    });

    it('AMOUNT_MISMATCH: our recorded amount disagrees with the provider\'s', async () => {
      const w = newWindow();
      const { paymentTxId } = await fundedCustomer();
      await t.pool.query('UPDATE payments.payment_transactions SET amount_minor = amount_minor + 1 WHERE id = $1', [paymentTxId]);
      const res = await reconcile(w);
      expect(res.body.data.records).toEqual([expect.objectContaining({ status: 'AMOUNT_MISMATCH', expected: { amount_minor: RUPEES_500 + 1, currency: 'INR' }, actual: { amount_minor: RUPEES_500, currency: 'INR' } })]);
    });

    it('only the requested period is compared (start inclusive, end exclusive)', async () => {
      const w = newWindow();
      await fundedCustomer();
      t.clock.advanceSeconds(600); // the next payment is created exactly at w.to
      await fundedCustomer();
      expect((await reconcile(w)).body.data).toMatchObject({ matched: 1, exceptions: 0 });
      expect((await reconcile({ from: w.to, to: new Date(w.to.getTime() + 60_000) })).body.data).toMatchObject({ matched: 1, exceptions: 0 });
    });

    it('rejects an empty/inverted period and one longer than 31 days', async () => {
      const w = newWindow();
      expect((await reconcile({ from: w.to, to: w.from })).status).toBe(422);
      expect((await reconcile({ from: w.from, to: w.from })).status).toBe(422);
      expect((await reconcile({ from: w.from, to: new Date(w.from.getTime() + 32 * 86_400_000) })).body.code).toBe('PERIOD_TOO_LONG');
      expect((await h.adminPost(finance, '/admin/payments/reconciliation', { from: 'yesterday', to: 'today' })).status).toBe(422);
      expect((await h.adminGet(finance, `/admin/payments/reconciliation/${uuidv7()}`)).status).toBe(404);
    });
  });
});

describe('Payments with the provider DISABLED (the only configuration allowed in production)', () => {
  let t: TestApp;
  let h: PaymentsHarness;

  beforeAll(async () => {
    t = await bootTestApp({ PAYMENT_PROVIDER: 'disabled' });
    h = paymentsHarness(t);
  });
  afterAll(async () => {
    await t.close();
    delete process.env['PAYMENT_PROVIDER']; // bootTestApp writes to process.env; do not leak into other suites
  });

  it('refuses to start a payment, offers no sandbox checkout, and accepts no webhooks', async () => {
    const c = await h.newCustomer('9820000001');
    const res = await h.createIntent(c, RUPEES_500);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAYMENTS_DISABLED');
    expect(await h.count('SELECT count(*) AS n FROM payments.payment_intents')).toBe(0);

    expect((await h.pay(c, uuidv7())).status).toBe(404);
    const hook = h.sandbox.buildWebhook({ type: 'payment.captured', data: { payment_id: 'pay_sbx_x' } });
    expect((await h.webhook(hook)).status).toBe(404);
    expect((await h.webhook(hook, 'disabled')).status).toBe(503);
  });

  it('the wallet itself still works', async () => {
    const c = await h.newCustomer('9820000002');
    const a = await h.auth(c);
    const res = await t.http.get('/api/v1/wallet').set(a);
    expect(res.status).toBe(200);
    expect(res.body.data.available.amount_minor).toBe(0);
  });
});
