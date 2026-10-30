import { PayoutService, SandboxPayoutProvider } from '../src/modules/settlement';
import type { ProviderPayout } from '../src/modules/settlement';
import { PayableService } from '../src/modules/settlement/application/payable.service';
import { PayoutRejectedError } from '../src/modules/settlement/domain/payout-provider';
import { LedgerService, PLATFORM_ACCOUNTS } from '../src/modules/wallet-ledger';
import { Money, uuidv7 } from '../src/shared-kernel';
import { AdminSession, TestApp, bootTestApp } from './support/app';
import { Customer, PaymentsHarness, paymentsHarness } from './support/payments';

const SYS = { type: 'SYSTEM' as const };
const HOUR = 3600;
const ACCOUNT = { holder_name: 'Riya Sharma', account_number: '123456784321', ifsc: 'HDFC0001234' };
/** The sandbox refuses payouts to a beneficiary account ending 9999 (see SandboxPayoutProvider). */
const BLOCKED_ACCOUNT = { ...ACCOUNT, account_number: '123456789999' };
const ENV = { PAYOUT_DELAY_HOURS: '2', PAYOUT_ACCOUNT_COOLING_HOURS: '1', PAYOUT_MIN_MINOR: '10000', PAYOUT_MAX_MINOR: '100000', PAYOUT_MAX_CONSECUTIVE_FAILURES: '3' };
const ENV_KEYS = ['PAYOUT_PROVIDER', ...Object.keys(ENV)];
type CreateInput = Parameters<SandboxPayoutProvider['createPayout']>[0];

interface Provider {
  id: string;
  owner: Customer;
}
interface PayoutDbRow {
  id: string;
  status: string;
  amount_minor: string;
  provider_reference: string;
  attempts: number;
  last_error: string | null;
  needs_review: boolean;
  failure_reason: string | null;
  utr: string | null;
  provider_payout_id: string | null;
}

describe('Settlement & payouts: payables, bank accounts, payouts, failures, reconciliation (integration, real PostgreSQL, SANDBOX payout provider)', () => {
  let t: TestApp;
  let h: PaymentsHarness;
  let ledger: LedgerService;
  let payouts: PayoutService;
  let sandbox: SandboxPayoutProvider;
  let payer: Customer;
  let finance: AdminSession;
  let support: AdminSession;
  let phoneSeq = 9_840_000_000;

  // ===== arrangement helpers ==========================================================================================
  async function newProvider(approved = true): Promise<Provider> {
    const owner = await h.newCustomer(String(++phoneSeq));
    const a = await h.auth(owner);
    const res = await t.http.post('/api/v1/providers').set(a).send({ display_name: `Salon ${phoneSeq}` });
    expect(res.status).toBe(201);
    if (approved) await t.pool.query("UPDATE provider.providers SET status = 'APPROVED' WHERE id = $1", [res.body.data.id]);
    return { id: res.body.data.id as string, owner };
  }

  /** A settlement exactly as the booking engine posts it: held money -> provider payable (+ commission, + optional customer refund). */
  async function earn(providerId: string, net: number, commission = 0, refund = 0) {
    const bookingId = uuidv7();
    const hold = await ledger.createHold({ bookingId, customerId: payer.userId, amount: Money.of(BigInt(net + commission + refund), 'INR'), idempotencyKey: `hold:${bookingId}`, actor: SYS });
    const allocations = [
      { kind: 'PROVIDER_PAYABLE' as const, providerId, amount: Money.of(BigInt(net), 'INR') },
      ...(commission > 0 ? [{ kind: 'PLATFORM_COMMISSION' as const, amount: Money.of(BigInt(commission), 'INR') }] : []),
      ...(refund > 0 ? [{ kind: 'CUSTOMER_REFUND' as const, amount: Money.of(BigInt(refund), 'INR') }] : []),
    ];
    const settled = await ledger.settleHold({ holdId: hold.id, allocations, reason: 'SERVICE_COMPLETED', idempotencyKey: `settle:${bookingId}`, actor: SYS });
    return { bookingId, txnId: settled.txnId };
  }

  const putAccount = async (p: Provider, body: object = ACCOUNT) => {
    const a = await h.auth(p.owner);
    return t.http.put(`/api/v1/providers/${p.id}/payout-account`).set(a).send(body);
  };
  const getAs = async (c: Customer, path: string) => {
    const a = await h.auth(c);
    return t.http.get(`/api/v1${path}`).set(a);
  };
  const adminGet = (a: AdminSession, path: string) => h.adminGet(a, path);
  const adminPost = (a: AdminSession, path: string, body: object = {}) => h.adminPost(a, path, body);
  const payableBalance = async (providerId: string) => Number((await ledger.getProviderPayableBalance(providerId)).minor);
  const clearing = () => h.platformBalance(PLATFORM_ACCOUNTS.PAYOUT_CLEARING);
  const gateway = () => h.platformBalance(PLATFORM_ACCOUNTS.GATEWAY_CLEARING);
  const payoutRows = (providerId: string) => t.pool.query('SELECT * FROM settlement.payouts WHERE provider_id = $1 ORDER BY created_at, id', [providerId]).then((r) => r.rows as PayoutDbRow[]);
  const payableStates = (providerId: string) =>
    t.pool.query('SELECT status, count(*)::int AS n FROM settlement.provider_payables WHERE provider_id = $1 GROUP BY status ORDER BY status', [providerId]).then((r) => Object.fromEntries(r.rows.map((x) => [x.status, x.n])) as Record<string, number>);
  const sandboxCount = (reference: string) => h.count('SELECT count(*) AS n FROM settlement.sandbox_payouts WHERE reference = $1', [reference]);
  const expectIntegrityOk = async () => {
    const res = await adminGet(finance, '/admin/payouts/integrity');
    expect(res.body.data.violations).toEqual([]);
    expect(res.body.data.ok).toBe(true);
  };

  /** An approved provider with a VERIFIED bank account that has passed its cooling-off period. */
  async function readyProvider(accountBody: object = ACCOUNT): Promise<Provider> {
    const p = await newProvider();
    expect((await putAccount(p, accountBody)).status).toBe(200);
    await h.drain(); // the bank check
    t.clock.advanceSeconds(2 * HOUR); // longer than the 1h cooling-off
    return p;
  }
  /** Earns, records the payables and lets the payout delay pass. */
  async function earnEligible(p: Provider, ...nets: number[]) {
    for (const n of nets) await earn(p.id, n);
    await h.drain();
    t.clock.advanceSeconds(2 * HOUR + 1);
  }
  /** earn -> reserve -> hand to the provider. Leaves the payout SUBMITTED (or FAILED if refused). */
  const fullCycle = async (p: Provider, ...nets: number[]) => {
    await earnEligible(p, ...nets);
    await payouts.runBatch();
    await h.drain();
  };

  beforeAll(async () => {
    t = await bootTestApp(ENV);
    h = paymentsHarness(t);
    ledger = t.app.get(LedgerService);
    payouts = t.app.get(PayoutService);
    sandbox = t.app.get(SandboxPayoutProvider);
    payer = await h.newCustomer(String(++phoneSeq));
    await ledger.creditDevTestFunds({ customerId: payer.userId, amount: Money.of(1_000_000_000n, 'INR'), paymentRef: uuidv7(), idempotencyKey: `fund:${uuidv7()}`, actor: SYS });
    finance = await t.loginAdmin({ phone: '9700000401', email: 'finance-settle@example.com', roles: ['FINANCE_OPERATOR'] });
    support = await t.loginAdmin({ phone: '9700000402', email: 'support-settle@example.com', roles: ['SUPPORT_OPERATOR'] });
  });
  beforeEach(async () => {
    await h.drain(); // no leftover outbox events from an earlier test may be consumed by this one
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await t.close();
    for (const k of ENV_KEYS) delete process.env[k]; // bootTestApp writes to process.env; do not leak into other suites
  });

  // =====================================================================================================
  describe('payables: what a provider is owed (recorded from the ledger, not from booking events)', () => {
    it('records the net amount, the commission and the payout delay from the ledger posting — asynchronously', async () => {
      const p = await newProvider();
      const { bookingId, txnId } = await earn(p.id, 18_000, 2_000);
      expect((await t.pool.query('SELECT 1 FROM settlement.provider_payables WHERE provider_id = $1', [p.id])).rowCount).toBe(0);

      await h.drain();
      const row = (await t.pool.query('SELECT * FROM settlement.provider_payables WHERE provider_id = $1', [p.id])).rows[0];
      expect(row).toMatchObject({ net_minor: '18000', commission_minor: '2000', status: 'ACCRUED', ledger_txn_id: txnId, booking_id: bookingId, payout_id: null });
      expect(row.eligible_at.getTime() - t.clock.now().getTime()).toBe(2 * HOUR * 1000);
      expect(await payableBalance(p.id)).toBe(18_000);
      await expectIntegrityOk();
    });

    it('a late-cancellation settlement (part refunded to the customer) records only what the provider earned', async () => {
      const p = await newProvider();
      await earn(p.id, 9_000, 1_000, 10_000);
      await h.drain();
      const row = (await t.pool.query('SELECT net_minor, commission_minor FROM settlement.provider_payables WHERE provider_id = $1', [p.id])).rows[0];
      expect(row).toEqual({ net_minor: '9000', commission_minor: '1000' });
      expect(await payableBalance(p.id)).toBe(9_000);
    });

    it('is idempotent: a redelivered credit records nothing new', async () => {
      const p = await newProvider();
      const { txnId } = await earn(p.id, 5_000);
      await h.drain();
      const svc = t.app.get(PayableService);
      expect(await svc.record({ providerId: p.id, bookingId: null, ledgerTxnId: txnId, netMinor: 5_000n, commissionMinor: 0n, currency: 'INR' })).toBe('DUPLICATE');
      expect((await t.pool.query('SELECT 1 FROM settlement.provider_payables WHERE provider_id = $1', [p.id])).rowCount).toBe(1);
      expect(await svc.record({ providerId: p.id, bookingId: null, ledgerTxnId: uuidv7(), netMinor: 0n, commissionMinor: 0n, currency: 'INR' })).toBe('IGNORED');
    });

    it('the earnings view separates "earned", "payable now", "in a transfer" and "paid" — and says what is blocking a payout', async () => {
      const p = await newProvider();
      await earn(p.id, 12_000);
      await h.drain();
      let e = (await getAs(p.owner, `/providers/${p.id}/earnings`)).body.data;
      expect(e).toMatchObject({ waiting: { amount_minor: 12_000 }, eligible: { amount_minor: 0 }, in_payout: { amount_minor: 0 }, paid_total: { amount_minor: 0 }, payout: { blocker: 'NO_VERIFIED_ACCOUNT', minimum: { amount_minor: 10_000 }, account: null } });
      expect(e.next_eligible_at).not.toBeNull();

      t.clock.advanceSeconds(2 * HOUR + 1);
      e = (await getAs(p.owner, `/providers/${p.id}/earnings`)).body.data;
      expect(e).toMatchObject({ waiting: { amount_minor: 0 }, eligible: { amount_minor: 12_000 } });
    });

    it('is visible only to that provider (404 for strangers and customers, 401 without a token)', async () => {
      const a = await newProvider();
      const b = await newProvider();
      await earn(a.id, 5_000);
      await h.drain();
      for (const path of ['earnings', 'payables', 'payouts', 'payout-account']) {
        expect((await getAs(b.owner, `/providers/${a.id}/${path}`)).status).toBe(404);
        expect((await getAs(payer, `/providers/${a.id}/${path}`)).status).toBe(404);
        expect((await t.http.get(`/api/v1/providers/${a.id}/${path}`)).status).toBe(401);
      }
      const mine = await getAs(a.owner, `/providers/${a.id}/payables`);
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0]).toMatchObject({ net: { amount_minor: 5_000 }, status: 'ACCRUED' });
    });
  });

  // =====================================================================================================
  describe('the bank account payouts go to', () => {
    it('is stored encrypted, shown only masked, verified with the bank, and never leaks into audit or events', async () => {
      const p = await newProvider();
      const res = await putAccount(p);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'PENDING_VERIFICATION', account_number: 'XXXXXX4321', ifsc: 'HDFC0001234', holder_name: 'Riya Sharma' });
      expect(JSON.stringify(res.body)).not.toContain(ACCOUNT.account_number);

      await h.drain();
      const got = await getAs(p.owner, `/providers/${p.id}/payout-account`);
      expect(got.body.data).toMatchObject({ status: 'VERIFIED', account_number: 'XXXXXX4321' });
      expect(got.body.data.verified_at).not.toBeNull();
      expect(JSON.stringify(got.body)).not.toContain(ACCOUNT.account_number);

      const id = res.body.data.id as string;
      const stored = (await t.pool.query('SELECT account_number_enc, holder_name_enc, account_last4, account_hash FROM settlement.payout_accounts WHERE id = $1', [id])).rows[0];
      expect(Buffer.from(stored.account_number_enc).includes(Buffer.from(ACCOUNT.account_number))).toBe(false);
      expect(Buffer.from(stored.holder_name_enc).includes(Buffer.from('Riya'))).toBe(false);
      expect(stored.account_last4).toBe('4321');
      expect(stored.account_hash).toMatch(/^[0-9a-f]{64}$/);

      const trail = (await t.pool.query("SELECT coalesce(string_agg(coalesce(before_data::text, '') || coalesce(after_data::text, '') || metadata::text, ' '), '') AS blob FROM audit.audit_logs WHERE entity_id = $1", [id])).rows[0].blob as string;
      expect(trail).toContain('4321'); // the last four digits are fine to keep
      expect(trail).not.toContain(ACCOUNT.account_number);
      expect(trail).not.toContain('Riya');
      const events = (await t.pool.query('SELECT payload::text AS p FROM platform.outbox_events WHERE aggregate_id = $1', [id])).rows.map((r) => r.p).join(' ');
      expect(events).not.toContain(ACCOUNT.account_number);
      expect(events).not.toContain('Riya');
    });

    it.each([
      ['a bad IFSC', { ifsc: 'HDFC1001234' }, 'ifsc'],
      ['a short account number', { account_number: '12345678' }, 'account_number'],
      ['letters in the account number', { account_number: '1234abcd5678' }, 'account_number'],
      ['a markup-looking holder name', { holder_name: '<b>Riya</b>' }, 'holder_name'],
    ])('rejects %s and stores nothing', async (_l, patch, field) => {
      const p = await newProvider();
      const res = await putAccount(p, { ...ACCOUNT, ...patch });
      expect(res.status).toBe(422);
      expect(res.body.errors.fields).toHaveProperty(field);
      expect((await t.pool.query('SELECT 1 FROM settlement.payout_accounts WHERE provider_id = $1', [p.id])).rowCount).toBe(0);
    });

    it('rejects unknown fields (a client cannot set a status or a verified flag)', async () => {
      const p = await newProvider();
      expect((await putAccount(p, { ...ACCOUNT, status: 'VERIFIED' })).status).toBe(422);
      expect((await putAccount(p, { ...ACCOUNT, verified_at: '2020-01-01T00:00:00Z' })).status).toBe(422);
    });

    it('replacing the account swaps it atomically, keeps the history, and the new one is unverified until the bank check passes; the same account again is a no-op', async () => {
      const p = await newProvider();
      const first = (await putAccount(p)).body.data;
      await h.drain();
      expect((await putAccount(p)).body.data.id).toBe(first.id);

      const second = (await putAccount(p, { ...ACCOUNT, account_number: '998877665544', ifsc: 'SBIN0001234' })).body.data;
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('PENDING_VERIFICATION');
      const rows = (await t.pool.query('SELECT status, verified_at FROM settlement.payout_accounts WHERE provider_id = $1 ORDER BY created_at', [p.id])).rows;
      expect(rows.map((r) => r.status)).toEqual(['REPLACED', 'PENDING_VERIFICATION']);
      expect(rows[0].verified_at).not.toBeNull(); // the old account keeps its history
      expect(await h.count("SELECT count(*) AS n FROM platform.outbox_events WHERE event_type = 'settlement.payout_account_changed' AND aggregate_id = $1", [p.id])).toBe(1);
    });

    it.each([
      ['an account the bank cannot find', '555500000000', 'ACCOUNT_NOT_FOUND'],
      ['an account registered to someone else', '555500001111', 'NAME_MISMATCH'],
    ])('does NOT accept %s', async (_label, number, reason) => {
      const p = await newProvider();
      await putAccount(p, { ...ACCOUNT, account_number: number });
      await h.drain();
      expect((await getAs(p.owner, `/providers/${p.id}/payout-account`)).body.data).toMatchObject({ status: 'VERIFICATION_FAILED', failure_reason: reason, verified_at: null });
    });

    it('a check the bank has not answered yet stays pending and is completed by the sweeper', async () => {
      const p = await newProvider();
      await putAccount(p, { ...ACCOUNT, account_number: '555500002222' });
      await h.drain();
      expect((await getAs(p.owner, `/providers/${p.id}/payout-account`)).body.data.status).toBe('PENDING_VERIFICATION');
      t.clock.advanceSeconds(180);
      expect((await payouts.sweep()).accounts).toBeGreaterThanOrEqual(1);
      expect((await getAs(p.owner, `/providers/${p.id}/payout-account`)).body.data.status).toBe('VERIFIED');
    });

    it('only the provider\'s owner may set or read it, and changes are rate-limited (account-takeover control)', async () => {
      const p = await newProvider();
      const stranger = await newProvider();
      expect((await putAccount({ id: p.id, owner: stranger.owner })).status).toBe(404);
      expect((await putAccount({ id: p.id, owner: payer })).status).toBe(404);
      for (let i = 0; i < 5; i++) expect((await putAccount(p, { ...ACCOUNT, account_number: `20000000000${i}` })).status).toBe(200);
      expect((await putAccount(p, { ...ACCOUNT, account_number: '200000000099' })).status).toBe(429);
    });

    it('finance sees accounts masked; no endpoint ever returns a full account number', async () => {
      const p = await newProvider();
      await putAccount(p);
      const res = await adminGet(finance, `/admin/payout-accounts?provider_id=${p.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ account_number: 'XXXXXX4321' });
      expect(JSON.stringify(res.body)).not.toContain(ACCOUNT.account_number);
    });
  });

  // =====================================================================================================
  describe('creating a payout: who is paid, when, and how much', () => {
    it('pays a ready provider: reserves the money first, sends it after commit, completes on the bank\'s confirmation', async () => {
      const p = await readyProvider();
      await earnEligible(p, 5_000, 6_000, 9_000);
      expect(await payableBalance(p.id)).toBe(20_000);
      const clearingBefore = await clearing();

      await payouts.runBatch();
      const [po] = await payoutRows(p.id);
      expect(po).toMatchObject({ status: 'RESERVED', amount_minor: '20000', provider_reference: po!.id });
      expect(await payableBalance(p.id)).toBe(0); // no longer "owed" ...
      expect(await clearing()).toBe(clearingBefore + 20_000); // ... and visibly IN TRANSIT, not paid
      expect(await payableStates(p.id)).toEqual({ IN_PAYOUT: 3 });
      expect(await sandboxCount(po!.id)).toBe(0); // the provider has not been called yet

      await h.drain();
      expect((await payoutRows(p.id))[0]).toMatchObject({ status: 'SUBMITTED', provider_payout_id: expect.stringMatching(/^pout_sbx_/) });
      expect((await getAs(p.owner, `/providers/${p.id}/earnings`)).body.data).toMatchObject({ in_payout: { amount_minor: 20_000 }, paid_total: { amount_minor: 0 } });

      const gatewayBeforePaid = await gateway();
      await sandbox.advance(po!.id, 'PAID', { utr: 'UTR123456789012' });
      t.clock.advanceSeconds(180);
      await payouts.sweep();
      expect((await payoutRows(p.id))[0]).toMatchObject({ status: 'PAID', utr: 'UTR123456789012' });
      expect(await payableStates(p.id)).toEqual({ PAID: 3 });
      expect(await clearing()).toBe(clearingBefore); // the transit money is gone ...
      expect(await gateway()).toBe(gatewayBeforePaid - 20_000); // ... because it LEFT the platform
      expect((await getAs(p.owner, `/providers/${p.id}/earnings`)).body.data).toMatchObject({ in_payout: { amount_minor: 0 }, paid_total: { amount_minor: 20_000 } });
      expect(await h.auditCount('payout.created', po!.id)).toBe(1);
      expect(await h.auditCount('payout.paid', po!.id)).toBe(1);
      await expectIntegrityOk();
      await h.expectLedgerOk();
    });

    it('the provider sees the transfer and its items; another provider cannot (404)', async () => {
      const p = await readyProvider();
      const other = await newProvider();
      await fullCycle(p, 12_000);
      const [po] = await payoutRows(p.id);
      const own = await getAs(p.owner, `/providers/${p.id}/payouts/${po!.id}`);
      expect(own.status).toBe(200);
      expect(own.body.data).toMatchObject({ amount: { amount_minor: 12_000 }, status: 'SUBMITTED' });
      expect(own.body.data.items).toHaveLength(1);
      expect(own.body.data).not.toHaveProperty('attempts'); // operational detail is for finance
      expect(own.body.data).not.toHaveProperty('last_error');
      expect((await getAs(other.owner, `/providers/${other.id}/payouts/${po!.id}`)).status).toBe(404);
      expect((await getAs(p.owner, `/providers/${p.id}/payouts`)).body.data.map((x: { id: string }) => x.id)).toContain(po!.id);
    });

    const dropBankAccount = async (p: Provider): Promise<void> => {
      await t.pool.query("UPDATE settlement.payout_accounts SET status = 'REPLACED' WHERE provider_id = $1", [p.id]);
    };
    const suspendProvider = async (p: Provider): Promise<void> => {
      await t.pool.query("UPDATE provider.providers SET status = 'SUSPENDED' WHERE id = $1", [p.id]);
    };
    const freezeProvider = async (p: Provider): Promise<void> => {
      await adminPost(finance, `/admin/payouts/providers/${p.id}/freeze`, { reason: 'investigating a complaint' });
    };
    it.each([
      ['has no verified bank account', 'NO_VERIFIED_ACCOUNT', dropBankAccount],
      ['was suspended', 'PROVIDER_NOT_APPROVED', suspendProvider],
      ['is paused by finance', 'PAUSED', freezeProvider],
    ] as [string, 'NO_VERIFIED_ACCOUNT' | 'PROVIDER_NOT_APPROVED' | 'PAUSED', (p: Provider) => Promise<void>][])('pays nothing when the provider %s — and tells them why', async (_label, blocker, arrange) => {
      const p = await readyProvider();
      await earnEligible(p, 15_000);
      await arrange(p);
      const batch = await payouts.runBatch();
      expect(batch.skipped[blocker]).toBeGreaterThanOrEqual(1);
      expect(await payoutRows(p.id)).toHaveLength(0);
      expect(await payableBalance(p.id)).toBe(15_000); // untouched
      expect((await getAs(p.owner, `/providers/${p.id}/earnings`)).body.data.payout.blocker).toBe(blocker);
    });

    it('waits out the cooling-off period after a bank account is verified (account-takeover control), then pays', async () => {
      const p = await newProvider();
      await earn(p.id, 15_000);
      await h.drain();
      t.clock.advanceSeconds(2 * HOUR + 1); // the money is eligible ...
      await putAccount(p);
      await h.drain(); // ... but the bank account was verified just now

      const first = await payouts.runBatch();
      expect(first.skipped['ACCOUNT_COOLING_OFF']).toBeGreaterThanOrEqual(1);
      expect(await payoutRows(p.id)).toHaveLength(0);
      expect((await getAs(p.owner, `/providers/${p.id}/earnings`)).body.data.payout.blocker).toBe('ACCOUNT_COOLING_OFF');

      t.clock.advanceSeconds(HOUR + 1); // the 1h cooling-off has elapsed
      await payouts.runBatch();
      expect(await payoutRows(p.id)).toHaveLength(1);
    });

    it('does not pay before the payout delay has passed', async () => {
      const p = await readyProvider();
      await earn(p.id, 20_000);
      await h.drain();
      await payouts.runBatch();
      expect(await payoutRows(p.id)).toHaveLength(0);
      t.clock.advanceSeconds(2 * HOUR + 1);
      await payouts.runBatch();
      expect(await payoutRows(p.id)).toHaveLength(1);
    });

    it('keeps accruing below the minimum, and pays once the total reaches it', async () => {
      const p = await readyProvider();
      await earnEligible(p, 9_000);
      await payouts.runBatch();
      expect(await payoutRows(p.id)).toHaveLength(0);
      expect((await getAs(p.owner, `/providers/${p.id}/earnings`)).body.data.payout.blocker).toBe('BELOW_MINIMUM');

      await earnEligible(p, 2_000);
      await payouts.runBatch();
      const rows = await payoutRows(p.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.amount_minor).toBe('11000');
    });

    it('packs oldest-first under the per-payout cap, one transfer in flight at a time, the rest on the next cycle', async () => {
      const p = await readyProvider();
      await earnEligible(p, 60_000, 50_000, 40_000);
      await payouts.runBatch();
      let rows = await payoutRows(p.id);
      expect(rows.map((r) => r.amount_minor)).toEqual(['60000']); // 60 + 50 would exceed the 100 000 cap: stop (never leapfrog)
      expect((await payouts.runBatch()).skipped['PAYOUT_IN_FLIGHT']).toBeGreaterThanOrEqual(1); // one at a time

      await h.drain();
      await sandbox.advance(rows[0]!.provider_reference, 'PAID');
      t.clock.advanceSeconds(180);
      await payouts.sweep();
      await payouts.runBatch();
      rows = await payoutRows(p.id);
      expect(rows.map((r) => r.amount_minor)).toEqual(['60000', '90000']);
      await expectIntegrityOk();
    });

    it('a single payable larger than the cap is paid alone instead of being stranded', async () => {
      const p = await readyProvider();
      await earnEligible(p, 150_000);
      await payouts.runBatch();
      expect((await payoutRows(p.id)).map((r) => r.amount_minor)).toEqual(['150000']);
    });

    it('CONCURRENCY: four simultaneous payout runs create exactly ONE payout for the provider and no payable is in two payouts', async () => {
      const p = await readyProvider();
      await earnEligible(p, 20_000, 30_000, 25_000);
      await Promise.all([payouts.runBatch(), payouts.runBatch(), payouts.runBatch(), payouts.runBatch()]);
      const rows = await payoutRows(p.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.amount_minor).toBe('75000');
      expect((await t.pool.query('SELECT payable_id FROM settlement.payout_items WHERE payout_id = $1', [rows[0]!.id])).rowCount).toBe(3);
      expect(await h.count('SELECT count(*) AS n FROM (SELECT payable_id FROM settlement.payout_items GROUP BY payable_id HAVING count(*) > 1) d')).toBe(0);
      // The row locks must PREVENT the contention. The ledger's own balance check would also stop a double reservation, but as a
      // backstop that raises an alarm — a quiet run proves the locks did their job and the backstop was never needed.
      expect(await h.count("SELECT count(*) AS n FROM platform.outbox_events WHERE event_type = 'settlement.payable_ledger_mismatch' AND aggregate_id = $1", [p.id])).toBe(0);
      await expectIntegrityOk();
      await h.expectLedgerOk();
    });

    it('refuses to pay when the payable rows claim more than the ledger holds: pays NOTHING and raises the alarm', async () => {
      const p = await readyProvider();
      await earnEligible(p, 20_000);
      await t.pool.query('UPDATE settlement.provider_payables SET net_minor = net_minor + 5000 WHERE provider_id = $1', [p.id]); // corrupt the read model
      const batch = await payouts.runBatch();
      expect(batch.skipped['LEDGER_MISMATCH']).toBeGreaterThanOrEqual(1);
      expect(await payoutRows(p.id)).toHaveLength(0);
      expect(await h.count("SELECT count(*) AS n FROM platform.outbox_events WHERE event_type = 'settlement.payable_ledger_mismatch' AND aggregate_id = $1", [p.id])).toBe(1);
      expect(await payableBalance(p.id)).toBe(20_000);
      const integrity = await adminGet(finance, '/admin/payouts/integrity');
      expect(integrity.body.data.ok).toBe(false);
      expect(integrity.body.data.violations.join(' ')).toContain('payable rows add up to');
      await t.pool.query('UPDATE settlement.provider_payables SET net_minor = net_minor - 5000 WHERE provider_id = $1', [p.id]); // put it back for the other tests
    });
  });

  // =====================================================================================================
  describe('CRITICAL TEST #7 — a payout retried after a timeout is paid ONCE (query before retry)', () => {
    it('the provider created the transfer but the response was lost: the retry FINDS it by our reference and never creates a second', async () => {
      const p = await readyProvider();
      await earnEligible(p, 25_000);
      const original: SandboxPayoutProvider['createPayout'] = sandbox.createPayout.bind(sandbox);
      let target = '';
      let dropped = false;
      const spy = jest.spyOn(sandbox, 'createPayout').mockImplementation(async (input: CreateInput): Promise<ProviderPayout> => {
        const created = await original(input);
        if (input.reference === target && !dropped) {
          dropped = true;
          throw new Error('socket hang up'); // it reached the provider and WAS created ... but we never heard back
        }
        return created;
      });

      await payouts.runBatch();
      const [po] = await payoutRows(p.id);
      target = po!.id;
      await h.drain();
      expect((await payoutRows(p.id))[0]).toMatchObject({ status: 'RESERVED', attempts: 1, last_error: 'socket hang up' }); // visible to operators although the transaction rolled back
      expect(await sandboxCount(target)).toBe(1);

      t.clock.advanceSeconds(60);
      await h.drain();
      expect(spy.mock.calls.filter((c) => c[0].reference === target)).toHaveLength(1); // the retry did NOT call create again
      expect(await sandboxCount(target)).toBe(1);
      expect((await payoutRows(p.id))[0]).toMatchObject({ status: 'SUBMITTED', provider_payout_id: expect.stringMatching(/^pout_sbx_/) });
      expect(await payableBalance(p.id)).toBe(0);
      await expectIntegrityOk();
    });

    it('the request never reached the provider: the retry creates it, once', async () => {
      const p = await readyProvider();
      await earnEligible(p, 25_000);
      const original: SandboxPayoutProvider['createPayout'] = sandbox.createPayout.bind(sandbox);
      let target = '';
      let failed = false;
      const spy = jest.spyOn(sandbox, 'createPayout').mockImplementation(async (input: CreateInput): Promise<ProviderPayout> => {
        if (input.reference === target && !failed) {
          failed = true;
          throw new Error('connect ETIMEDOUT'); // never created
        }
        return original(input);
      });
      await payouts.runBatch();
      target = (await payoutRows(p.id))[0]!.id;
      await h.drain();
      expect(await sandboxCount(target)).toBe(0);

      t.clock.advanceSeconds(60);
      await h.drain();
      expect(spy.mock.calls.filter((c) => c[0].reference === target)).toHaveLength(2);
      expect(await sandboxCount(target)).toBe(1);
      expect((await payoutRows(p.id))[0]!.status).toBe('SUBMITTED');
    });

    it('a stuck payout (its outbox event lost) is re-driven by the sweeper, and sweeping again changes nothing', async () => {
      const p = await readyProvider();
      await earnEligible(p, 25_000);
      await payouts.runBatch();
      const [po] = await payoutRows(p.id);
      await t.pool.query("DELETE FROM platform.outbox_events WHERE event_type = 'settlement.payout_requested' AND aggregate_id = $1", [po!.id]);

      await payouts.sweep(); // too young: never races the normal path
      expect(await sandboxCount(po!.id)).toBe(0);
      t.clock.advanceSeconds(180);
      await payouts.sweep();
      await payouts.sweep();
      expect(await sandboxCount(po!.id)).toBe(1);
      expect((await payoutRows(p.id))[0]!.status).toBe('SUBMITTED');
    });

    it('an operator "refresh" is the same safe query: it can complete a payout the provider already paid', async () => {
      const p = await readyProvider();
      await fullCycle(p, 25_000);
      const [po] = await payoutRows(p.id);
      await sandbox.advance(po!.id, 'PAID');
      expect((await adminPost(finance, `/admin/payouts/${po!.id}/refresh`)).body.data.outcome).toBe('PAID');
      expect((await adminPost(finance, `/admin/payouts/${po!.id}/refresh`)).body.data.outcome).toBe('SKIPPED'); // already final
      expect(await h.count("SELECT count(*) AS n FROM ledger.transactions WHERE txn_type = 'PAYOUT_COMPLETE' AND business_ref_id = $1", [po!.id])).toBe(1);
    });
  });

  // =====================================================================================================
  describe('when the provider does not pay', () => {
    it('a definitive refusal fails the payout, returns the money to the provider\'s payable and delays the retry', async () => {
      const p = await readyProvider(BLOCKED_ACCOUNT);
      await fullCycle(p, 25_000);
      const [po] = await payoutRows(p.id);
      expect(po).toMatchObject({ status: 'FAILED', failure_reason: 'REJECTED_BY_PROVIDER: BENEFICIARY_BLOCKED' });
      expect(await payableBalance(p.id)).toBe(25_000); // owed again
      expect(await payableStates(p.id)).toEqual({ ACCRUED: 1 });
      const retryAt = (await t.pool.query('SELECT eligible_at FROM settlement.provider_payables WHERE provider_id = $1', [p.id])).rows[0].eligible_at as Date;
      expect(retryAt.getTime() - t.clock.now().getTime()).toBe(HOUR * 1000); // 1h after the first failure
      const types = (await t.pool.query('SELECT txn_type FROM ledger.transactions WHERE business_ref_id = $1', [po!.id])).rows.map((x) => x.txn_type as string);
      expect(types.sort()).toEqual(['PAYOUT_RESERVE', 'REVERSAL']); // compensated, never edited
      expect(await h.auditCount('payout.failed', po!.id)).toBe(1);
      await expectIntegrityOk();
      await h.expectLedgerOk();
    });

    it.each(['FAILED', 'REVERSED'] as const)('the provider later reports %s before paying: the money comes back, the next attempt is a NEW payout with a new reference', async (state) => {
      const p = await readyProvider();
      await fullCycle(p, 25_000);
      const [first] = await payoutRows(p.id);
      await sandbox.advance(first!.id, state, { reason: 'BANK_REFUSED' });
      t.clock.advanceSeconds(180);
      await payouts.sweep();
      expect((await payoutRows(p.id))[0]).toMatchObject({ status: 'FAILED', failure_reason: `${state}_AT_PROVIDER: BANK_REFUSED` });
      expect(await payableBalance(p.id)).toBe(25_000);

      t.clock.advanceSeconds(HOUR + 1); // the retry delay
      await payouts.runBatch();
      await h.drain();
      const rows = await payoutRows(p.id);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.id).not.toBe(first!.id);
      expect(rows[1]!.provider_reference).not.toBe(first!.provider_reference);
      expect(rows[0]!.status).toBe('FAILED');
      expect(await h.count('SELECT count(*) AS n FROM settlement.payout_items WHERE payout_id = $1', [first!.id])).toBe(1); // history keeps what was in the failed one
      await expectIntegrityOk();
    });

    it('three failures in a row automatically pause the provider for review; finance can lift the pause', async () => {
      const p = await readyProvider();
      await earnEligible(p, 25_000);
      for (let failures = 1; failures <= 3; failures++) {
        await payouts.runBatch();
        await h.drain();
        const open = (await payoutRows(p.id)).find((r) => r.status === 'SUBMITTED' || r.status === 'RESERVED')!;
        await sandbox.advance(open.id, 'FAILED', { reason: 'BANK_REFUSED' });
        t.clock.advanceSeconds(180);
        await payouts.sweep();
        t.clock.advanceSeconds(Math.min(2 ** (failures - 1), 24) * HOUR + 1); // the escalating retry delay: 1h, 2h, 4h
      }
      expect((await payoutRows(p.id)).map((r) => r.status)).toEqual(['FAILED', 'FAILED', 'FAILED']);
      const hold = (await t.pool.query('SELECT reason, automatic FROM settlement.payout_holds WHERE provider_id = $1', [p.id])).rows[0];
      expect(hold.automatic).toBe(true);
      expect(hold.reason).toContain('3 consecutive payout failures');
      await payouts.runBatch();
      expect(await payoutRows(p.id)).toHaveLength(3); // paused: no fourth attempt

      expect((await adminPost(finance, `/admin/payouts/providers/${p.id}/unfreeze`)).body.data.was_frozen).toBe(true);
      await payouts.runBatch();
      expect(await payoutRows(p.id)).toHaveLength(4);
      expect(await h.auditCount('payout.provider_unfrozen', p.id)).toBe(1);
    });

    it('a transfer the bank returned AFTER it was reported paid is flagged for review and the provider paused — nothing is auto-corrected', async () => {
      const p = await readyProvider();
      await fullCycle(p, 25_000);
      const [po] = await payoutRows(p.id);
      await sandbox.advance(po!.id, 'PAID');
      await payouts.submit(po!.id);
      expect((await payoutRows(p.id))[0]!.status).toBe('PAID');
      const ledgerTxns = await h.count('SELECT count(*) AS n FROM ledger.transactions');

      // Reconciliation is how a post-payment reversal is normally noticed: ours says PAID, the provider now says REVERSED.
      await sandbox.advance(po!.id, 'REVERSED', { reason: 'RETURNED_BY_BANK' });
      const from = new Date(t.clock.now().getTime() - 86_400_000);
      const to = new Date(t.clock.now().getTime() + 86_400_000);
      const rec = await adminPost(finance, '/admin/payouts/reconciliation', { from: from.toISOString(), to: to.toISOString() });
      expect(rec.body.data.records).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'STATUS_MISMATCH', payout_id: po!.id })]));

      // An operator action / webhook applying the provider's record must not rewrite history either.
      const outcome = await payouts.applyProviderPayout(po!.id, { provider: 'sandbox', payoutId: po!.provider_payout_id!, reference: po!.provider_reference, amountMinor: 25_000n, currency: 'INR', status: 'REVERSED', failureReason: 'RETURNED_BY_BANK', createdAt: new Date() });
      expect(outcome).toBe('NEEDS_REVIEW');
      expect((await payoutRows(p.id))[0]).toMatchObject({ status: 'PAID', needs_review: true });
      expect(await payableStates(p.id)).toEqual({ PAID: 1 });
      expect(await h.count('SELECT count(*) AS n FROM payments.webhook_events WHERE false')).toBe(0);
      expect(await h.count('SELECT count(*) AS n FROM ledger.transactions')).toBe(ledgerTxns); // not a single posting was changed behind a human's back
      expect(await h.count('SELECT count(*) AS n FROM settlement.payout_holds WHERE provider_id = $1', [p.id])).toBe(1);
    });

    it('the provider says PAID for a payout we had already failed: flagged, provider paused (a double payment must be stopped, not booked)', async () => {
      const p = await readyProvider(BLOCKED_ACCOUNT);
      await fullCycle(p, 25_000);
      const [po] = await payoutRows(p.id);
      expect(po!.status).toBe('FAILED');
      const outcome = await payouts.applyProviderPayout(po!.id, { provider: 'sandbox', payoutId: 'pout_sbx_late', reference: po!.provider_reference, amountMinor: 25_000n, currency: 'INR', status: 'PAID', utr: 'UTRLATE', createdAt: new Date() });
      expect(outcome).toBe('NEEDS_REVIEW');
      const row = (await payoutRows(p.id))[0]!;
      expect(row).toMatchObject({ status: 'FAILED', needs_review: true });
      expect(row.last_error).toContain('PAID_AT_PROVIDER_AFTER_FAILED');
      expect(await h.count('SELECT count(*) AS n FROM settlement.payout_holds WHERE provider_id = $1', [p.id])).toBe(1);
      expect(await payableBalance(p.id)).toBe(25_000); // the books were not changed behind a human's back
      expect((await adminGet(finance, '/admin/payouts?needs_review=true')).body.data.map((x: { id: string }) => x.id)).toContain(po!.id);
    });

    it('a provider record with a different AMOUNT is never applied: flagged, no ledger movement', async () => {
      const p = await readyProvider();
      await fullCycle(p, 25_000);
      const [po] = await payoutRows(p.id);
      const before = await h.count('SELECT count(*) AS n FROM ledger.transactions');
      const outcome = await payouts.applyProviderPayout(po!.id, { provider: 'sandbox', payoutId: 'pout_x', reference: po!.provider_reference, amountMinor: 24_000n, currency: 'INR', status: 'PAID', createdAt: new Date() });
      expect(outcome).toBe('NEEDS_REVIEW');
      expect(await h.count('SELECT count(*) AS n FROM ledger.transactions')).toBe(before);
      expect((await payoutRows(p.id))[0]).toMatchObject({ status: 'SUBMITTED', needs_review: true });
    });

    it('the database refuses a payout that is final without its ledger posting, and a payable pointing nowhere while in a payout', async () => {
      const p = await readyProvider();
      await fullCycle(p, 25_000);
      const [po] = await payoutRows(p.id);
      await expect(t.pool.query("UPDATE settlement.payouts SET status = 'PAID' WHERE id = $1", [po!.id])).rejects.toMatchObject({ constraint: 'payouts_final_has_ledger_chk' });
      await expect(t.pool.query('UPDATE settlement.provider_payables SET payout_id = NULL WHERE payout_id = $1', [po!.id])).rejects.toMatchObject({ constraint: 'provider_payables_payout_chk' });
    });
  });

  // =====================================================================================================
  describe('authorization and the finance surface', () => {
    it('finance operates; support only looks; customers, providers and anonymous callers get nothing', async () => {
      const p = await readyProvider();
      await fullCycle(p, 25_000);
      const [po] = await payoutRows(p.id);
      const own = await h.auth(p.owner);

      const reads = ['/admin/payouts', `/admin/payouts/${po!.id}`, '/admin/payables', '/admin/payout-accounts', '/admin/payouts/integrity', '/admin/payouts/holds'];
      for (const path of reads) {
        expect((await t.http.get(`/api/v1${path}`).set(own)).status).toBe(403);
        expect((await t.http.get(`/api/v1${path}`)).status).toBe(401);
        expect((await adminGet(support, path)).status).toBe(200);
        expect((await adminGet(finance, path)).status).toBe(200);
      }
      const ops: [string, object][] = [
        ['/admin/payouts/run', {}],
        [`/admin/payouts/${po!.id}/refresh`, {}],
        [`/admin/payouts/providers/${p.id}/freeze`, { reason: 'because' }],
        [`/admin/payouts/providers/${p.id}/unfreeze`, {}],
        ['/admin/payouts/reconciliation', { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }],
      ];
      for (const [path, body] of ops) {
        expect((await t.http.post(`/api/v1${path}`).set(own).send(body)).status).toBe(403);
        expect((await adminPost(support, path, body)).status).toBe(403);
      }
      expect(await h.count('SELECT count(*) AS n FROM settlement.payout_holds WHERE provider_id = $1', [p.id])).toBe(0);
    });

    it('finance sees the operational detail a provider does not; filters and cursors work', async () => {
      const p = await readyProvider();
      await fullCycle(p, 25_000);
      const [po] = await payoutRows(p.id);
      expect((await adminGet(finance, `/admin/payouts/${po!.id}`)).body.data).toMatchObject({ provider_id: p.id, provider: 'sandbox', reference: po!.id, attempts: 0, needs_review: false });
      expect((await adminGet(finance, `/admin/payouts?provider_id=${p.id}&status=SUBMITTED&limit=1`)).body.data).toHaveLength(1);
      expect((await adminGet(finance, '/admin/payouts?status=BOGUS')).status).toBe(422);
      expect((await adminGet(finance, '/admin/payouts/not-a-uuid')).status).toBe(400);
      expect((await adminGet(finance, `/admin/payouts/${uuidv7()}`)).status).toBe(404);
      expect((await adminGet(finance, `/admin/payables?provider_id=${p.id}`)).body.data[0]).toMatchObject({ status: 'IN_PAYOUT', payout_id: po!.id });
    });

    it('freezing needs a reason, is audited once, and an unknown provider is a 404', async () => {
      const p = await newProvider();
      expect((await adminPost(finance, `/admin/payouts/providers/${p.id}/freeze`, { reason: 'x' })).status).toBe(422);
      expect((await adminPost(finance, `/admin/payouts/providers/${p.id}/freeze`, { reason: 'suspected fraud' })).status).toBe(200);
      expect(await h.auditCount('payout.provider_frozen', p.id)).toBe(1);
      expect((await adminPost(finance, `/admin/payouts/providers/${p.id}/freeze`, { reason: 'again' })).status).toBe(200); // idempotent
      expect(await h.auditCount('payout.provider_frozen', p.id)).toBe(1);
      expect((await adminGet(finance, '/admin/payouts/holds')).body.data.map((x: { provider_id: string }) => x.provider_id)).toContain(p.id);
      expect((await adminPost(finance, `/admin/payouts/providers/${uuidv7()}/freeze`, { reason: 'ghost provider' })).status).toBe(404);
      expect((await adminPost(finance, `/admin/payouts/providers/${p.id}/unfreeze`)).body.data.was_frozen).toBe(true);
      expect((await adminPost(finance, `/admin/payouts/providers/${p.id}/unfreeze`)).body.data.was_frozen).toBe(false);
    });

    it('"run now" performs one payout cycle and reports what it did', async () => {
      const p = await readyProvider();
      await earnEligible(p, 25_000);
      const res = await adminPost(finance, '/admin/payouts/run');
      expect(res.status).toBe(200);
      expect(res.body.data.batch.payouts).toBeGreaterThanOrEqual(1);
      expect(await payoutRows(p.id)).toHaveLength(1);
    });
  });

  // =====================================================================================================
  describe('reconciliation against the payout provider', () => {
    const newWindow = () => {
      t.clock.advanceSeconds(7_200);
      return t.clock.now();
    };
    const reconcile = (from: Date, to: Date) => adminPost(finance, '/admin/payouts/reconciliation', { from: from.toISOString(), to: to.toISOString() });
    const horizon = () => new Date(t.clock.now().getTime() + 600_000);

    it('a clean window has no exceptions and the run is persisted and audited', async () => {
      const from = newWindow();
      const p = await readyProvider();
      await fullCycle(p, 25_000);
      const res = await reconcile(from, horizon());
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ exceptions: 0, records: [] });
      expect(res.body.data.matched).toBeGreaterThanOrEqual(1);
      const stored = await adminGet(finance, `/admin/payouts/reconciliation/${res.body.data.id}`);
      expect(stored.body.data).toMatchObject({ id: res.body.data.id, exceptions: 0 });
      expect(await h.auditCount('payouts.reconciliation_run', res.body.data.id)).toBe(1);
    });

    it('MISSING_INTERNAL: the provider holds a payout we never made (the dangerous one)', async () => {
      const from = newWindow();
      await sandbox.createPayout({ reference: `rogue-${uuidv7()}`, amountMinor: 77_700n, currency: 'INR', destination: { accountNumber: '111122223333', ifsc: 'HDFC0001234', holderName: 'Nobody' } });
      const res = await reconcile(from, horizon());
      expect(res.body.data.records).toEqual([expect.objectContaining({ status: 'MISSING_INTERNAL', payout_id: null, actual: { amount_minor: 77_700, currency: 'INR' } })]);
    });

    it('MISSING_EXTERNAL, AMOUNT_MISMATCH and STATUS_MISMATCH are each reported with both sides', async () => {
      const from = newWindow();
      const a = await readyProvider();
      const b = await readyProvider();
      const c = await readyProvider();
      for (const p of [a, b, c]) await earnEligible(p, 25_000);
      await payouts.runBatch();
      await h.drain();
      const [pa] = await payoutRows(a.id);
      const [pb] = await payoutRows(b.id);
      const [pc] = await payoutRows(c.id);

      await t.pool.query('DELETE FROM settlement.sandbox_payouts WHERE reference = $1', [pa!.id]); // the provider forgot it
      await t.pool.query('UPDATE settlement.sandbox_payouts SET amount_minor = 24000 WHERE reference = $1', [pb!.id]); // the provider says a different amount
      await sandbox.advance(pc!.id, 'PAID'); // the provider paid; we still say SUBMITTED

      const res = await reconcile(from, horizon());
      const byRef = Object.fromEntries((res.body.data.records as { reference: string; status: string }[]).map((r) => [r.reference, r]));
      expect(byRef[pa!.id]).toMatchObject({ status: 'MISSING_EXTERNAL', actual: null, expected: { amount_minor: 25_000 } });
      expect(byRef[pb!.id]).toMatchObject({ status: 'AMOUNT_MISMATCH', expected: { amount_minor: 25_000 }, actual: { amount_minor: 24_000 } });
      expect(byRef[pc!.id]).toMatchObject({ status: 'STATUS_MISMATCH' });
    });

    it('rejects an inverted or over-long period and unknown runs', async () => {
      const from = newWindow();
      const to = new Date(from.getTime() + 600_000);
      expect((await reconcile(to, from)).status).toBe(422);
      expect((await reconcile(from, new Date(from.getTime() + 32 * 86_400_000))).body.code).toBe('PERIOD_TOO_LONG');
      expect((await adminGet(finance, `/admin/payouts/reconciliation/${uuidv7()}`)).status).toBe(404);
    });
  });

  // =====================================================================================================
  describe('the payout provider contract (sandbox)', () => {
    const dest = { accountNumber: '123456784321', ifsc: 'HDFC0001234', holderName: 'Riya Sharma' };

    it('is idempotent by reference: the same reference is the same transfer; a different amount is refused', async () => {
      const ref = `ref-${uuidv7()}`;
      const a = await sandbox.createPayout({ reference: ref, amountMinor: 5_000n, currency: 'INR', destination: dest });
      const b = await sandbox.createPayout({ reference: ref, amountMinor: 5_000n, currency: 'INR', destination: dest });
      expect(b.payoutId).toBe(a.payoutId);
      await expect(sandbox.createPayout({ reference: ref, amountMinor: 5_001n, currency: 'INR', destination: dest })).rejects.toBeInstanceOf(PayoutRejectedError);
      expect(await sandbox.fetchPayoutByReference(ref)).toMatchObject({ payoutId: a.payoutId, status: 'QUEUED' });
      expect(await sandbox.fetchPayoutByReference('never-seen')).toBeNull();
    });
  });
});

describe('Settlement with payouts DISABLED (the only configuration allowed in production)', () => {
  let t: TestApp;
  let h: PaymentsHarness;

  beforeAll(async () => {
    t = await bootTestApp({ ...ENV, PAYOUT_PROVIDER: 'disabled' });
    h = paymentsHarness(t);
  });
  afterAll(async () => {
    await t.close();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('keeps recording what providers are owed, leaves bank accounts quietly pending, and sends nothing', async () => {
    const owner = await h.newCustomer('9850000001');
    const a = await h.auth(owner);
    const provider = await t.http.post('/api/v1/providers').set(a).send({ display_name: 'Disabled Salon' });
    const id = provider.body.data.id as string;
    await t.pool.query("UPDATE provider.providers SET status = 'APPROVED' WHERE id = $1", [id]);

    const ledger = t.app.get(LedgerService);
    const customer = await h.newCustomer('9850000002');
    await ledger.creditDevTestFunds({ customerId: customer.userId, amount: Money.of(100_000n, 'INR'), paymentRef: uuidv7(), idempotencyKey: `fund:${uuidv7()}`, actor: SYS });
    const bookingId = uuidv7();
    const hold = await ledger.createHold({ bookingId, customerId: customer.userId, amount: Money.of(50_000n, 'INR'), idempotencyKey: `hold:${bookingId}`, actor: SYS });
    await ledger.settleHold({ holdId: hold.id, allocations: [{ kind: 'PROVIDER_PAYABLE', providerId: id, amount: Money.of(50_000n, 'INR') }], reason: 'SERVICE_COMPLETED', idempotencyKey: `settle:${bookingId}`, actor: SYS });
    const a2 = await h.auth(owner);
    expect((await t.http.put(`/api/v1/providers/${id}/payout-account`).set(a2).send(ACCOUNT)).status).toBe(200);
    await h.drain();

    expect((await t.pool.query('SELECT status FROM settlement.provider_payables WHERE provider_id = $1', [id])).rows).toEqual([{ status: 'ACCRUED' }]);
    expect((await t.pool.query('SELECT status FROM settlement.payout_accounts WHERE provider_id = $1', [id])).rows).toEqual([{ status: 'PENDING_VERIFICATION' }]);
    expect(await h.count("SELECT count(*) AS n FROM platform.outbox_events WHERE status = 'FAILED'")).toBe(0); // nothing burned its retries

    t.clock.advanceSeconds(3 * HOUR);
    const batch = await t.app.get(PayoutService).runBatch();
    expect(batch).toMatchObject({ payouts: 0, skipped: { PAYOUTS_DISABLED: 1 } });
    const a3 = await h.auth(owner);
    const earnings = await t.http.get(`/api/v1/providers/${id}/earnings`).set(a3);
    expect(earnings.body.data.payout.blocker).toBe('PAYOUTS_DISABLED');
    expect(earnings.body.data.eligible.amount_minor).toBe(50_000);
  });
});
