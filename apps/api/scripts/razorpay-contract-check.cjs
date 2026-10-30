#!/usr/bin/env node
/**
 * Contract check of the application's RazorpayPaymentProvider against the REAL Razorpay TEST-mode API.
 *
 *   pnpm --filter @tokengo/api build && pnpm --filter @tokengo/api razorpay:check
 *
 * Needs PAYMENT_PROVIDER=razorpay and RAZORPAY_KEY_ID (rzp_test_…) / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET in apps/api/.env.
 * It sends real requests to api.razorpay.com but moves NO money: it creates one test-mode ORDER (never paid), reads, and provokes
 * error responses. No database needed. It prints no secrets. Live keys are refused by the app's own configuration.
 *
 * Why it exists: the integration suites run against a local test double written from Razorpay's documentation. This is the check
 * that the double — and the adapter's error handling — match what Razorpay actually answers. Re-run it after any change to
 * razorpay.provider.ts, and whenever Razorpay announce API changes.
 */
const path = require('node:path');
const crypto = require('node:crypto');

const dist = (p) => require(path.join(__dirname, '..', 'dist', p));
const { loadConfig } = dist('shared-kernel/config');
const { RazorpayPaymentProvider } = dist('modules/payments/infrastructure/razorpay.provider');
const { ProviderRejectedError } = dist('modules/payments/domain/payment-provider');
const { signRazorpayWebhook } = dist('modules/payments/domain/razorpay');

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
};
const brief = (e) => `${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 140)}`;
// Razorpay ids are a prefix + 14 alphanumerics. These are VALID-FORMAT ids that do not exist.
const UNKNOWN_PAYMENT = 'pay_AbCdEfGhIjKlMn';
const UNKNOWN_REFUND = 'rfnd_AbCdEfGhIjKlMn';
const UNKNOWN_ORDER = 'order_AbCdEfGhIjKlMn';

(async () => {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    console.error(`Configuration refused: ${brief(e)}`);
    process.exit(2);
  }
  if (config.payments.provider !== 'razorpay') {
    console.error('Set PAYMENT_PROVIDER=razorpay (and the RAZORPAY_* values) in apps/api/.env first.');
    process.exit(2);
  }
  const cfg = config.payments.razorpay;
  const provider = new RazorpayPaymentProvider(config);
  check('configuration accepts the credentials as Razorpay TEST mode', cfg.keyId.startsWith('rzp_test_'));

  const raw = async (method, p) => {
    const res = await fetch(cfg.baseUrl + p, { method, headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64') } });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json };
  };

  try {
    const now = new Date();
    const list = await provider.listPayments({ from: new Date(now.getTime() - 30 * 86_400_000), to: now });
    check('authenticated; listPayments (from/to/count/skip paging) works', Array.isArray(list), `${list.length} payments in the last 30 days`);
  } catch (e) { check('authenticated; listPayments works', false, brief(e)); }

  let orderId;
  const receipt = crypto.randomUUID();
  try {
    orderId = (await provider.createOrder({ amountMinor: 50_000n, currency: 'INR', receipt })).orderId;
    check('createOrder (paise, receipt = our UUID) returns a real order id', /^order_[A-Za-z0-9]+$/.test(orderId), orderId);
    const wire = await raw('GET', `/orders/${orderId}`);
    check('the order exists at Razorpay: 50000 INR, our receipt, status created', wire.json?.amount === 50000 && wire.json?.currency === 'INR' && wire.json?.receipt === receipt && wire.json?.status === 'created');
    check('listOrderPayments on an unpaid order is empty', (await provider.listOrderPayments(orderId)).length === 0);
  } catch (e) { check('createOrder / read back', false, brief(e)); }

  // "does not exist" answers — all of these must read as NOT FOUND, never as a refusal and never as an error
  for (const [label, fn, expected] of [
    ['fetchPayment(valid-format unknown id) is null (HTTP 400 "The id provided does not exist")', () => provider.fetchPayment(UNKNOWN_PAYMENT), null],
    ['fetchRefund(valid-format unknown id) is null (HTTP 400 "invalid request sent")', () => provider.fetchRefund(UNKNOWN_REFUND), null],
    ['listOrderPayments(unknown order) is empty (HTTP 200, empty collection)', () => provider.listOrderPayments(UNKNOWN_ORDER), []],
  ]) {
    try { check(label, JSON.stringify(await fn()) === JSON.stringify(expected)); } catch (e) { check(label, false, brief(e)); }
  }

  // DEFINITIVE refusals (Razorpay's application answered with an error object) -> ProviderRejectedError
  try {
    await provider.createOrder({ amountMinor: 50n, currency: 'INR', receipt: 'below-minimum' });
    check('an order below the minimum amount is refused', false, 'it was ACCEPTED');
  } catch (e) { check('an order below the minimum amount is a DEFINITIVE refusal', e instanceof ProviderRejectedError, brief(e)); }
  try {
    await provider.createRefund({ paymentId: UNKNOWN_PAYMENT, amountMinor: 100n, idempotencyKey: crypto.randomUUID() });
    check('refunding an unknown payment is refused', false, 'it was accepted');
  } catch (e) { check('refund of an unknown payment is a DEFINITIVE refusal (the customer would be made whole)', e instanceof ProviderRejectedError, brief(e)); }

  // NOT refusals: a bare gateway 404 ("no Route matched") says nothing about whether the operation happened
  try {
    await provider.createRefund({ paymentId: 'pay_notAValidFormat', amountMinor: 100n, idempotencyKey: crypto.randomUUID() });
    check('a gateway 404 on refund creation is not accepted', false, 'it was accepted');
  } catch (e) { check('a bare GATEWAY 404 is NOT a refusal (retried, never returns the customer\'s money)', !(e instanceof ProviderRejectedError), brief(e)); }

  const over = await raw('GET', '/payments?count=101');
  check('Razorpay rejects count=101 and accepts count=100 (my page size)', over.status === 400 && (await raw('GET', '/payments?count=100')).status === 200);

  const bad = new RazorpayPaymentProvider({ payments: { razorpay: { ...cfg, keySecret: 'definitely-not-the-secret' } } });
  try {
    await bad.fetchPayment(UNKNOWN_PAYMENT);
    check('a wrong key secret is not mistaken for "unknown id"', false, 'returned without error');
  } catch (e) { check('a WRONG key secret is a retryable error, NOT a refusal', !(e instanceof ProviderRejectedError) && /HTTP 401/.test(e.message), brief(e)); }

  const body = Buffer.from(JSON.stringify({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x' } } } }));
  const env = provider.verifyWebhook(body, { 'x-razorpay-signature': signRazorpayWebhook(cfg.webhookSecret, body), 'x-razorpay-event-id': 'evt_check' });
  check('verifyWebhook accepts a correctly signed event and routes it', env.type === 'payment.captured' && env.data.payment_id === 'pay_x');

  if (orderId) console.log(`\n(created test order ${orderId}; it was never paid and moves no money)`);
  console.log(results.every(Boolean) ? 'RAZORPAY CONTRACT CHECK PASSED' : 'RAZORPAY CONTRACT CHECK FAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error('check crashed:', brief(e));
  process.exit(2);
});
