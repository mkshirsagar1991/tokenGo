// Redelivers SIGNED Razorpay-shaped webhooks to a locally running API for a REAL captured Razorpay TEST payment and refund, and proves
// that nothing is credited twice: the same event id again, the same payment under a different event id, a burst of simultaneous
// deliveries, a refund event for a refund that is already complete, a forged signature, a missing signature, and an unknown payment id.
//
//   pnpm --filter @tokengo/api razorpay:webhook-check
//
// PREREQUISITES (local development only)
//   - The API (and worker) are running with PAYMENT_PROVIDER=razorpay and RAZORPAY_* test keys in apps/api/.env.
//   - The dev database already holds a CAPTURED Razorpay payment and a refund of it (pay in Checkout from the customer app, then
//     refund it from the admin portal), so the events have a real provider payment to look up: webhook bodies are never trusted for
//     amounts or status, the API fetches the payment from Razorpay first.
//   - Docker Desktop is up with the compose Postgres (container `tokengo-postgres`); this script reads the ledger through
//     `docker exec ... psql` so it does not depend on the application's own code. Override with DB_CONTAINER / DB_NAME / DB_USER.
//
// The webhook secret is read from apps/api/.env and never printed. API_BASE overrides http://localhost:3000/api/v1.
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const SECRET = env.RAZORPAY_WEBHOOK_SECRET;
if (!SECRET) {
  console.error('RAZORPAY_WEBHOOK_SECRET is not set in apps/api/.env');
  process.exit(2);
}
const BASE = `${process.env.API_BASE || 'http://localhost:3000/api/v1'}/payments/webhooks/razorpay`;
const [CONTAINER, DB, DB_USER] = [process.env.DB_CONTAINER || 'tokengo-postgres', process.env.DB_NAME || 'tokengo', process.env.DB_USER || 'tokengo'];
const psql = (sql) => execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', DB_USER, '-d', DB, '-Atc', sql]).toString().trim();

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
};

const payment = psql("SELECT provider_payment_id FROM payments.payment_transactions WHERE provider = 'razorpay' AND status = 'CAPTURED' ORDER BY created_at DESC LIMIT 1");
const refund = psql("SELECT provider_refund_id FROM payments.refunds WHERE provider_refund_id IS NOT NULL AND status = 'SUCCEEDED' ORDER BY created_at DESC LIMIT 1");
if (!payment || !refund) {
  console.error('Needs a captured Razorpay payment and a succeeded refund in the dev database (see PREREQUISITES).');
  process.exit(2);
}
const customer = psql(`SELECT i.customer_id FROM payments.payment_intents i JOIN payments.payment_transactions t ON t.intent_id = i.id WHERE t.provider_payment_id = '${payment}'`);
const balance = () => psql(`SELECT balance_minor FROM ledger.accounts WHERE account_type = 'CUSTOMER_AVAILABLE' AND owner_id = '${customer}'`);
const ledgerTxns = () => psql('SELECT count(*) FROM ledger.transactions');
console.log(`(using real ids ${payment} and ${refund}; the webhook secret is not shown)`);

const send = async (body, { eventId = randomUUID(), badSignature = false, noSignature = false } = {}) => {
  const raw = Buffer.from(JSON.stringify(body));
  const headers = { 'content-type': 'application/json', 'x-razorpay-event-id': eventId };
  if (!noSignature) headers['x-razorpay-signature'] = badSignature ? 'f'.repeat(64) : createHmac('sha256', SECRET).update(raw).digest('hex');
  const res = await fetch(BASE, { method: 'POST', headers, body: raw });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, json, eventId };
};
const captured = (id) => ({ entity: 'event', event: 'payment.captured', contains: ['payment'], payload: { payment: { entity: { id, entity: 'payment', status: 'captured' } } }, created_at: Math.floor(Date.now() / 1000) });

const before = { balance: balance(), txns: ledgerTxns() };
const first = await send(captured(payment));
check('a correctly signed payment.captured is accepted (200)', first.status === 200, JSON.stringify(first.json));
const again = await send(captured(payment), { eventId: first.eventId });
check('the SAME event id delivered again is accepted and deduplicated (200)', again.status === 200 && again.json?.status === 'duplicate', JSON.stringify(again.json));
const other = await send(captured(payment));
check('the same payment under a DIFFERENT event id is accepted (200)', other.status === 200, JSON.stringify(other.json));
const burst = await Promise.all(Array.from({ length: 6 }, () => send(captured(payment))));
check('6 simultaneous deliveries of the same payment all answer 200', burst.every((r) => r.status === 200), burst.map((r) => r.status).join(','));
const refunded = await send({ entity: 'event', event: 'refund.processed', payload: { refund: { entity: { id: refund, payment_id: payment, status: 'processed' } } } });
check('a refund.processed for the already-completed refund is accepted (200)', refunded.status === 200, JSON.stringify(refunded.json));
check('a FORGED signature is rejected (401)', (await send(captured(payment), { badSignature: true })).status === 401);
check('a webhook with NO signature is rejected (401)', (await send(captured(payment), { noSignature: true })).status === 401);
const unknown = await send(captured('pay_DOESNOTEXIST000'));
check('an unknown payment id does not crash the endpoint (it is answered with a retryable 5xx or a 2xx, never credited)', [200, 202, 409, 422, 503].includes(unknown.status), `status ${unknown.status}`);

await new Promise((r) => setTimeout(r, 4000)); // let the worker drain any follow-up work
const after = { balance: balance(), txns: ledgerTxns() };
check('the customer wallet balance is UNCHANGED by all of the above', after.balance === before.balance, `${before.balance} -> ${after.balance} (paise)`);
check('NO ledger transaction was created by the redeliveries', after.txns === before.txns, `${before.txns} -> ${after.txns}`);
check('exactly one payment record exists for the real payment', psql(`SELECT count(*) FROM payments.payment_transactions WHERE provider_payment_id = '${payment}'`) === '1');
check('every ledger transaction still sums to zero', psql("SELECT count(*) FROM (SELECT txn_id FROM ledger.entries GROUP BY txn_id HAVING sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0) x") === '0');

console.log(results.every(Boolean) ? 'ALL WEBHOOK CHECKS PASSED' : `FAILED: ${results.filter((r) => !r).length} of ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
