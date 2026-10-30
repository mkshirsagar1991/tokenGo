import { PaymentRecoveryService, SandboxPaymentProvider } from '../../src/modules/payments';
import type { SignedWebhook } from '../../src/modules/payments/infrastructure/sandbox.provider';
import { PaymentSettlementService } from '../../src/modules/payments/application/payment-settlement.service';
import { LedgerIntegrityService, LedgerService, PLATFORM_ACCOUNTS } from '../../src/modules/wallet-ledger';
import { OutboxDispatcher, uuidv7 } from '../../src/shared-kernel';
import type { AdminSession, TestApp } from './app';

export interface Customer {
  userId: string;
  phone: string;
  accessToken: string;
}

/** Everything the payments suites need, bound to one booted app. */
export function paymentsHarness(t: TestApp) {
  const sandbox = t.app.get(SandboxPaymentProvider);
  const ledger = t.app.get(LedgerService);
  const integrity = t.app.get(LedgerIntegrityService);
  const dispatcher = t.app.get(OutboxDispatcher);
  const recovery = t.app.get(PaymentRecoveryService);
  const settlement = t.app.get(PaymentSettlementService);

  const secondsLeft = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp as number) - t.clock.now().getTime() / 1000;

  /** Tests move the clock around; sign in again when the access token is about to lapse. */
  const auth = async (c: Customer) => {
    if (secondsLeft(c.accessToken) < 90) c.accessToken = (await t.login(c.phone)).accessToken;
    return { Authorization: `Bearer ${c.accessToken}` };
  };
  const adminAuth = async (a: AdminSession) => {
    if (secondsLeft(a.accessToken) < 90) Object.assign(a, await t.reloginAdmin(a));
    return { Authorization: `Bearer ${a.accessToken}` };
  };

  const newCustomer = async (phone: string): Promise<Customer> => ({ ...(await t.login(phone)), phone });

  // NOTE: authenticate BEFORE creating the supertest request. A request starts listening when it is created, and
  // a login performed while it is pending would close the shared server underneath it (see the D9 note in STATUS.md).
  const createIntent = async (c: Customer, amountMinor: number, key = `topup-${uuidv7()}`) => {
    const a = await auth(c);
    return t.http.post('/api/v1/payments/intents').set(a).set('Idempotency-Key', key).send({ amount_minor: amountMinor });
  };
  const getIntent = async (c: Customer, id: string) => {
    const a = await auth(c);
    return t.http.get(`/api/v1/payments/intents/${id}`).set(a);
  };
  const verify = async (c: Customer, id: string) => {
    const a = await auth(c);
    return t.http.post(`/api/v1/payments/intents/${id}/verify`).set(a);
  };
  const pay = async (c: Customer, intentId: string, outcome: 'SUCCESS' | 'FAILURE' = 'SUCCESS', extra: { deliver_webhook?: boolean; amount_minor?: number } = {}) => {
    const a = await auth(c);
    return t.http.post('/api/v1/payments/sandbox/pay').set(a).send({ intent_id: intentId, outcome, ...extra });
  };
  /**
   * Delivers the EXACT signed bytes. The body is sent as a string on purpose: with a JSON content type supertest would
   * JSON.stringify a Buffer (turning it into {"type":"Buffer",...}) and the signature could never match.
   */
  const webhook = (hook: Pick<SignedWebhook, 'headers' | 'rawBody'>, provider = 'sandbox') => t.http.post(`/api/v1/payments/webhooks/${provider}`).set(hook.headers).send(hook.rawBody.toString('utf8'));

  const adminGet = async (a: AdminSession, path: string) => {
    const h = await adminAuth(a);
    return t.http.get(`/api/v1${path}`).set(h);
  };
  const adminPost = async (a: AdminSession, path: string, body: object = {}, headers: Record<string, string> = {}) => {
    const h = await adminAuth(a);
    return t.http.post(`/api/v1${path}`).set(h).set(headers).send(body);
  };

  const count = async (sql: string, params: unknown[] = []) => Number((await t.pool.query(sql, params)).rows[0].n);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0] as T;
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await dispatcher.processBatch()).claimed === 0) break;
  };
  const available = async (c: { userId: string }) => Number((await ledger.getBalance(c.userId)).available.minor);
  const held = async (c: { userId: string }) => Number((await ledger.getBalance(c.userId)).held.minor);
  const platformBalance = async (accountId: string) => Number((await one<{ b: string }>('SELECT balance_minor AS b FROM ledger.accounts WHERE id = $1', [accountId])).b);
  const orderIdOf = async (intentId: string) => (await one<{ o: string }>('SELECT provider_order_id AS o FROM payments.payment_intents WHERE id = $1', [intentId])).o;
  const topupTxns = (customerId: string) =>
    count(
      `SELECT count(*) AS n FROM ledger.transactions t
         JOIN ledger.entries e ON e.txn_id = t.id
         JOIN ledger.wallet_accounts w ON w.available_account_id = e.account_id
        WHERE w.customer_id = $1 AND t.txn_type = 'TOPUP'`,
      [customerId],
    );
  const auditCount = (action: string, entityId?: string) =>
    count(`SELECT count(*) AS n FROM audit.audit_logs WHERE action = $1 AND ($2::text IS NULL OR entity_id = $2::text)`, [action, entityId ?? null]);
  const expectLedgerOk = async () => expect((await integrity.check()).violations).toEqual([]);

  /** A successful top-up through the real HTTP flow. Returns the ids needed to refund/inspect it. */
  const fund = async (c: Customer, amountMinor: number) => {
    const created = await createIntent(c, amountMinor);
    expect(created.status).toBe(201);
    const intentId = created.body.data.id as string;
    const paid = await pay(c, intentId, 'SUCCESS');
    expect(paid.status).toBe(200);
    expect(paid.body.data.webhook_delivered).toBe(true);
    const tx = await one<{ id: string; provider_payment_id: string }>('SELECT id, provider_payment_id FROM payments.payment_transactions WHERE intent_id = $1 AND status = $2', [intentId, 'CAPTURED']);
    return { intentId, paymentTxId: tx.id, providerPaymentId: tx.provider_payment_id };
  };

  return { sandbox, ledger, integrity, dispatcher, recovery, settlement, PLATFORM_ACCOUNTS, auth, adminAuth, newCustomer, createIntent, getIntent, verify, pay, webhook, adminGet, adminPost, count, one, drain, available, held, platformBalance, orderIdOf, topupTxns, auditCount, expectLedgerOk, fund };
}
export type PaymentsHarness = ReturnType<typeof paymentsHarness>;
