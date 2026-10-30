import { AppConfig, APP_CONFIG, Clock, Money, OutboxService, UnitOfWork, uuidv7 } from '../src/shared-kernel';
import { LedgerService, LedgerIntegrityService } from '../src/modules/wallet-ledger';
import { LedgerPoster } from '../src/modules/wallet-ledger/application/ledger-poster';
import { AdminSession, TestApp, bootTestApp } from './support/app';

const inr = (rupees: number) => Money.of(BigInt(Math.round(rupees * 100)), 'INR');
const SYS = { type: 'SYSTEM' as const };

describe('Wallet ledger: holds, settlement, immutability, reconciliation (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let ledger: LedgerService;
  let integrity: LedgerIntegrityService;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const count = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0].n as number;
  const bal = async (customerId: string) => {
    const b = await ledger.getBalance(customerId);
    return { available: Number(b.available.minor) / 100, held: Number(b.held.minor) / 100 };
  };
  const fund = (customerId: string, rupees: number, key = `fund:${uuidv7()}`) =>
    ledger.creditDevTestFunds({ customerId, amount: inr(rupees), paymentRef: uuidv7(), idempotencyKey: key, actor: SYS });
  const hold = (customerId: string, rupees: number, bookingId = uuidv7(), key = `hold:${bookingId}`) =>
    ledger.createHold({ bookingId, customerId, amount: inr(rupees), idempotencyKey: key, actor: SYS });
  const expectIntegrityOk = async () => {
    const r = await integrity.check();
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  };

  async function newCustomer(phone: string): Promise<{ userId: string; accessToken: string }> {
    return t.login(phone);
  }

  beforeAll(async () => {
    t = await bootTestApp();
    ledger = t.app.get(LedgerService);
    integrity = t.app.get(LedgerIntegrityService);
  });
  afterAll(async () => {
    await t.close();
  });

  // =====================================================================================================
  describe('the documented example (requirements §12)', () => {
    it('₹1000 available -> hold ₹200 -> available ₹800 / held ₹200; release -> back to ₹1000 / ₹0', async () => {
      const c = await newCustomer('9600000001');
      await fund(c.userId, 1000);
      expect(await bal(c.userId)).toEqual({ available: 1000, held: 0 });

      const bookingId = uuidv7();
      const h = await hold(c.userId, 200, bookingId);
      expect(h).toMatchObject({ status: 'ACTIVE', bookingId, customerId: c.userId });
      expect(h.amount.toJSON()).toEqual({ amount_minor: 20000, currency: 'INR' });
      expect(await bal(c.userId)).toEqual({ available: 800, held: 200 });

      const released = await ledger.releaseHold({ holdId: h.id, reason: 'PROVIDER_REJECTED', idempotencyKey: `release:${h.id}`, actor: SYS });
      expect(released.changed).toBe(true);
      expect(released.hold.status).toBe('RELEASED');
      expect(await bal(c.userId)).toEqual({ available: 1000, held: 0 });
      await expectIntegrityOk();
    });

    it('settlement allocates the held ₹200 to provider payable ₹180 and platform commission ₹20 (10 %)', async () => {
      const c = await newCustomer('9600000002');
      const providerId = uuidv7();
      await fund(c.userId, 1000);
      const h = await hold(c.userId, 200);
      const { commission, net } = inr(200).splitCommissionBps(1000);
      const r = await ledger.settleHold({
        holdId: h.id,
        allocations: [
          { kind: 'PROVIDER_PAYABLE', providerId, amount: net },
          { kind: 'PLATFORM_COMMISSION', amount: commission },
        ],
        reason: 'SERVICE_COMPLETED',
        idempotencyKey: `settle:${h.id}`,
        actor: SYS,
      });
      expect(r.hold.status).toBe('SETTLED');
      expect(await bal(c.userId)).toEqual({ available: 800, held: 0 });

      const payable = await t.pool.query("SELECT balance_minor FROM ledger.accounts WHERE owner_type = 'PROVIDER' AND owner_id = $1 AND account_type = 'PROVIDER_PAYABLE'", [providerId]);
      expect(payable.rows[0].balance_minor).toBe('18000');
      const lines = await t.pool.query('SELECT a.account_type, e.direction, e.amount_minor::int AS amt FROM ledger.entries e JOIN ledger.accounts a ON a.id = e.account_id WHERE e.txn_id = $1 ORDER BY e.account_seq, a.account_type', [r.txnId]);
      expect(lines.rows.map((x) => `${x.direction} ${x.account_type} ${x.amt}`).sort()).toEqual(['CREDIT PLATFORM_COMMISSION 2000', 'CREDIT PROVIDER_PAYABLE 18000', 'DEBIT CUSTOMER_HELD 20000']);
      await expectIntegrityOk();
    });

    it('a late cancellation splits the hold: 50 % refund to the customer, the rest to provider + commission, in one transaction', async () => {
      const c = await newCustomer('9600000003');
      await fund(c.userId, 500);
      const h = await hold(c.userId, 200);
      const fee = inr(100); // customer keeps ₹100, ₹100 is the cancellation fee
      const { commission, net } = fee.splitCommissionBps(1000);
      await ledger.settleHold({
        holdId: h.id,
        allocations: [{ kind: 'CUSTOMER_REFUND', amount: inr(100) }, { kind: 'PROVIDER_PAYABLE', providerId: uuidv7(), amount: net }, { kind: 'PLATFORM_COMMISSION', amount: commission }],
        reason: 'CUSTOMER_CANCELLED_LATE',
        idempotencyKey: `settle:${h.id}`,
        actor: SYS,
      });
      expect(await bal(c.userId)).toEqual({ available: 400, held: 0 }); // 500 - 200 + 100 refund
      await expectIntegrityOk();
    });
  });

  // =====================================================================================================
  describe('insufficient funds and the double-spend defence', () => {
    it('refuses a hold the available balance cannot cover and persists nothing', async () => {
      const c = await newCustomer('9600000004');
      await fund(c.userId, 100);
      const before = await count('SELECT count(*)::int AS n FROM ledger.transactions');
      await expect(hold(c.userId, 250)).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        status: 409,
        details: { available: { amount_minor: 10000 }, required: { amount_minor: 25000 }, shortfall: { amount_minor: 15000, currency: 'INR' } },
      });
      expect(await count('SELECT count(*)::int AS n FROM ledger.transactions')).toBe(before);
      expect(await count('SELECT count(*)::int AS n FROM ledger.holds WHERE customer_id = $1', [c.userId])).toBe(0);
      expect(await bal(c.userId)).toEqual({ available: 100, held: 0 });
    });

    it('two requests racing for the SAME money: exactly one wins (critical test #2)', async () => {
      const c = await newCustomer('9600000005');
      await fund(c.userId, 200);
      const results = await Promise.allSettled([hold(c.userId, 200), hold(c.userId, 200)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      expect(await bal(c.userId)).toEqual({ available: 0, held: 200 });
      await expectIntegrityOk();
    });

    it('twelve ₹30 holds against ₹100: exactly three succeed and the books stay exact', async () => {
      const c = await newCustomer('9600000006');
      await fund(c.userId, 100);
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => hold(c.userId, 30)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(await bal(c.userId)).toEqual({ available: 10, held: 90 });
      expect(await count("SELECT count(*)::int AS n FROM ledger.holds WHERE customer_id = $1 AND status = 'ACTIVE'", [c.userId])).toBe(3);
      await expectIntegrityOk();
    });

    it('the database itself refuses a negative customer balance, even if the application were wrong', async () => {
      const c = await newCustomer('9600000007');
      await fund(c.userId, 10);
      const w = await ledger.findWallet(c.userId);
      await expect(t.pool.query('UPDATE ledger.accounts SET balance_minor = -1 WHERE id = $1', [w!.availableAccountId])).rejects.toThrow(/accounts_customer_nonneg_chk/);
    });
  });

  // =====================================================================================================
  describe('idempotency and exactly-once closing (critical tests #3, #5, #6, #10)', () => {
    it('replaying a hold with the same key returns the SAME hold — even after the funds were consumed', async () => {
      const c = await newCustomer('9600000008');
      await fund(c.userId, 200);
      const bookingId = uuidv7();
      const first = await hold(c.userId, 200, bookingId, 'hold:replay-1');
      expect(await bal(c.userId)).toEqual({ available: 0, held: 200 }); // nothing left to spend
      const again = await hold(c.userId, 200, bookingId, 'hold:replay-1'); // would fail a funds check if it re-ran
      expect(again.id).toBe(first.id);
      expect(await count('SELECT count(*)::int AS n FROM ledger.holds WHERE booking_id = $1', [bookingId])).toBe(1);
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE booking_id = $1 AND txn_type = 'HOLD_CREATE'", [bookingId])).toBe(1);
      await expect(hold(c.userId, 200, uuidv7(), 'hold:replay-1')).rejects.toMatchObject({ code: 'LEDGER_KEY_REUSED' }); // key bound to another booking
    });

    it('only one ACTIVE hold per booking and purpose', async () => {
      const c = await newCustomer('9600000009');
      await fund(c.userId, 500);
      const bookingId = uuidv7();
      await hold(c.userId, 100, bookingId, 'hold:a');
      await expect(hold(c.userId, 100, bookingId, 'hold:b')).rejects.toMatchObject({ code: 'HOLD_EXISTS' });
      expect(await bal(c.userId)).toEqual({ available: 400, held: 100 }); // the failed attempt left no trace
    });

    it('releasing twice — sequentially or concurrently — posts exactly one release', async () => {
      const c = await newCustomer('9600000010');
      await fund(c.userId, 300);
      const h = await hold(c.userId, 300);
      const release = (key: string) => ledger.releaseHold({ holdId: h.id, reason: 'EXPIRED', idempotencyKey: key, actor: SYS });
      const results = await Promise.all([release('rel-1'), release('rel-2'), release('rel-3'), release('rel-4')]);
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect((await release('rel-5')).changed).toBe(false);
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE booking_id = $1 AND txn_type = 'HOLD_RELEASE'", [h.bookingId])).toBe(1);
      expect(await bal(c.userId)).toEqual({ available: 300, held: 0 });
      await expectIntegrityOk();
    });

    it('settling twice posts once; settling a released hold (or releasing a settled one) is refused', async () => {
      const c = await newCustomer('9600000011');
      await fund(c.userId, 600);
      const providerId = uuidv7();
      const alloc = [{ kind: 'PROVIDER_PAYABLE' as const, providerId, amount: inr(180) }, { kind: 'PLATFORM_COMMISSION' as const, amount: inr(20) }];

      const h = await hold(c.userId, 200);
      const a = await ledger.settleHold({ holdId: h.id, allocations: alloc, reason: 'DONE', idempotencyKey: 'settle-1', actor: SYS });
      const b = await ledger.settleHold({ holdId: h.id, allocations: alloc, reason: 'DONE', idempotencyKey: 'settle-2', actor: SYS });
      expect(a.changed).toBe(true);
      expect(b).toMatchObject({ changed: false, txnId: a.txnId });
      await expect(ledger.releaseHold({ holdId: h.id, reason: 'X', idempotencyKey: 'rel-x', actor: SYS })).rejects.toMatchObject({ code: 'HOLD_ALREADY_CLOSED' });

      const h2 = await hold(c.userId, 100);
      await ledger.releaseHold({ holdId: h2.id, reason: 'X', idempotencyKey: 'rel-y', actor: SYS });
      await expect(ledger.settleHold({ holdId: h2.id, allocations: [{ kind: 'PLATFORM_COMMISSION', amount: inr(100) }], reason: 'X', idempotencyKey: 'settle-y', actor: SYS })).rejects.toMatchObject({ code: 'HOLD_ALREADY_CLOSED' });
      await expectIntegrityOk();
    });

    it('a refund-style release racing a settlement: exactly one outcome, ledger balanced (critical test #10)', async () => {
      for (let round = 0; round < 6; round++) {
        const c = await newCustomer(`96000001${20 + round}`);
        await fund(c.userId, 200);
        const h = await hold(c.userId, 200);
        const results = await Promise.allSettled([
          ledger.releaseHold({ holdId: h.id, reason: 'CANCELLED', idempotencyKey: `race-rel-${h.id}`, actor: SYS }),
          ledger.settleHold({ holdId: h.id, allocations: [{ kind: 'PROVIDER_PAYABLE', providerId: uuidv7(), amount: inr(180) }, { kind: 'PLATFORM_COMMISSION', amount: inr(20) }], reason: 'COMPLETED', idempotencyKey: `race-set-${h.id}`, actor: SYS }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'HOLD_ALREADY_CLOSED' });
        const final = await ledger.findHold(h.id);
        expect(['RELEASED', 'SETTLED']).toContain(final!.status);
        const b = await bal(c.userId);
        expect(b.held).toBe(0);
        expect(b.available).toBe(final!.status === 'RELEASED' ? 200 : 0);
      }
      await expectIntegrityOk();
    });

    it('allocations that do not add up to the held amount are refused — no money is created or lost', async () => {
      const c = await newCustomer('9600000012');
      await fund(c.userId, 300);
      const h = await hold(c.userId, 200);
      for (const bad of [[inr(199)], [inr(201)], [inr(100), inr(50)]]) {
        await expect(
          ledger.settleHold({ holdId: h.id, allocations: bad.map((m) => ({ kind: 'PLATFORM_COMMISSION' as const, amount: m })), reason: 'X', idempotencyKey: `bad-${bad.length}-${bad[0]!.minor}`, actor: SYS }),
        ).rejects.toMatchObject({ code: 'LEDGER_INVARIANT_VIOLATION' });
      }
      expect((await ledger.findHold(h.id))!.status).toBe('ACTIVE');
      await expectIntegrityOk();
    });
  });

  // =====================================================================================================
  describe('immutability and integrity enforced by the database', () => {
    let someTxn: string;
    beforeAll(async () => {
      const c = await newCustomer('9600000013');
      await fund(c.userId, 50);
      someTxn = (await t.pool.query('SELECT id FROM ledger.transactions ORDER BY posted_at LIMIT 1')).rows[0].id;
    });

    it('rejects UPDATE, DELETE and TRUNCATE on transactions and entries', async () => {
      await expect(t.pool.query("UPDATE ledger.entries SET amount_minor = 1")).rejects.toThrow(/append-only/);
      await expect(t.pool.query('DELETE FROM ledger.entries')).rejects.toThrow(/append-only/);
      await expect(t.pool.query('TRUNCATE ledger.entries')).rejects.toThrow(/append-only/);
      await expect(t.pool.query("UPDATE ledger.transactions SET txn_type = 'X'")).rejects.toThrow(/append-only/);
      await expect(t.pool.query('DELETE FROM ledger.transactions')).rejects.toThrow(/append-only/);
      // PostgreSQL's own FK guard fires before our trigger here; either way the table cannot be truncated.
      await expect(t.pool.query('TRUNCATE ledger.transactions')).rejects.toThrow(/append-only|referenced in a foreign key/);
    });

    it('refuses an unbalanced transaction at COMMIT (deferred trigger), and a single-entry transaction', async () => {
      const client = await t.pool.connect();
      try {
        const insertTxn = async (id: string) =>
          client.query("INSERT INTO ledger.transactions (id, txn_type, currency, idempotency_key, actor_type, posted_at) VALUES ($1, 'TEST', 'INR', $2, 'SYSTEM', now())", [id, `k-${id}`]);
        const acct = (await t.pool.query("SELECT id FROM ledger.accounts WHERE account_type = 'ADJUSTMENT'")).rows[0].id;

        await client.query('BEGIN');
        const id1 = uuidv7();
        await insertTxn(id1);
        await client.query("INSERT INTO ledger.entries (id, txn_id, account_id, direction, amount_minor, account_seq, balance_after_minor) VALUES (gen_random_uuid(), $1, $2, 'DEBIT', 100, 9990001, 100)", [id1, acct]);
        await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);

        await client.query('BEGIN');
        const id2 = uuidv7();
        await insertTxn(id2);
        const other = (await t.pool.query("SELECT id FROM ledger.accounts WHERE account_type = 'GATEWAY_CLEARING'")).rows[0].id;
        await client.query("INSERT INTO ledger.entries (id, txn_id, account_id, direction, amount_minor, account_seq, balance_after_minor) VALUES (gen_random_uuid(), $1, $2, 'DEBIT', 100, 9990002, 100), (gen_random_uuid(), $1, $3, 'CREDIT', 99, 9990003, 99)", [id2, acct, other]);
        await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect(someTxn).toBeDefined();
    });

    it('a closed hold is frozen: no reopening, no re-closing, no amount change, no deletion', async () => {
      const c = await newCustomer('9600000014');
      await fund(c.userId, 100);
      const h = await hold(c.userId, 100);
      await expect(t.pool.query("UPDATE ledger.holds SET amount_minor = 1 WHERE id = $1", [h.id])).rejects.toThrow(/immutable/);
      await ledger.releaseHold({ holdId: h.id, reason: 'X', idempotencyKey: `rel-${h.id}`, actor: SYS });
      await expect(t.pool.query("UPDATE ledger.holds SET status = 'ACTIVE', close_txn_id = NULL, closed_at = NULL WHERE id = $1", [h.id])).rejects.toThrow(/already RELEASED/);
      await expect(t.pool.query("UPDATE ledger.holds SET status = 'SETTLED' WHERE id = $1", [h.id])).rejects.toThrow(/already RELEASED/);
      await expect(t.pool.query('DELETE FROM ledger.holds WHERE id = $1', [h.id])).rejects.toThrow(/append-only/);
    });

    it('rejects a 2nd ACTIVE hold for the same booking at the database level', async () => {
      const c = await newCustomer('9600000015');
      await fund(c.userId, 100);
      const h = await hold(c.userId, 10);
      await expect(
        t.pool.query("INSERT INTO ledger.holds (id, booking_id, customer_id, purpose, amount_minor, currency, create_txn_id, created_at) VALUES (gen_random_uuid(), $1, $2, 'BOOKING', 5, 'INR', $3, now())", [h.bookingId, c.userId, h.createTxnId]),
      ).rejects.toThrow(/holds_active_key/);
    });

    it('integrity check detects tampered cached balances and holds that disagree with the held balance', async () => {
      const c = await newCustomer('9600000016');
      await fund(c.userId, 100);
      await hold(c.userId, 40);
      await expectIntegrityOk();
      const w = (await ledger.findWallet(c.userId))!;

      await t.pool.query('UPDATE ledger.accounts SET balance_minor = balance_minor + 1 WHERE id = $1', [w.availableAccountId]);
      let r = await integrity.check();
      expect(r.ok).toBe(false);
      expect(r.violations.map((v) => v.check)).toEqual(expect.arrayContaining(['ACCOUNT_BALANCE_MATCHES_ENTRIES', 'TRIAL_BALANCE']));
      await t.pool.query('UPDATE ledger.accounts SET balance_minor = balance_minor - 1 WHERE id = $1', [w.availableAccountId]);
      await expectIntegrityOk();

      // the held balance must always equal the sum of ACTIVE holds
      await t.pool.query('ALTER TABLE ledger.holds DISABLE TRIGGER holds_guard');
      try {
        await t.pool.query("UPDATE ledger.holds SET status = 'RELEASED', close_txn_id = create_txn_id, closed_at = now() WHERE customer_id = $1", [c.userId]);
        r = await integrity.check();
        expect(r.violations.map((v) => v.check)).toEqual(expect.arrayContaining(['HELD_BALANCE_EQUALS_ACTIVE_HOLDS', 'CLOSED_HOLD_HAS_MATCHING_TXN']));
      } finally {
        // Put the book back exactly as it was: later tests assert a clean ledger.
        await t.pool.query("UPDATE ledger.holds SET status = 'ACTIVE', close_txn_id = NULL, closed_at = NULL WHERE customer_id = $1", [c.userId]);
        await t.pool.query('ALTER TABLE ledger.holds ENABLE TRIGGER holds_guard');
      }
      await expectIntegrityOk();
    });
  });

  // =====================================================================================================
  describe('compensating transactions (never edit, always reverse)', () => {
    it('a transaction can be reversed exactly once, restoring balances; reversals cannot be reversed', async () => {
      const c = await newCustomer('9600000017');
      const funded = await fund(c.userId, 500);
      expect(await bal(c.userId)).toEqual({ available: 500, held: 0 });
      const rev = await ledger.reverseTransaction({ txnId: funded.txnId, reason: 'Mis-posted test credit', idempotencyKey: `rev-${funded.txnId}`, actor: SYS });
      expect(rev.created).toBe(true);
      expect(await bal(c.userId)).toEqual({ available: 0, held: 0 });
      const row = (await t.pool.query('SELECT reverses_txn_id, txn_type FROM ledger.transactions WHERE id = $1', [rev.txnId])).rows[0];
      expect(row).toMatchObject({ reverses_txn_id: funded.txnId, txn_type: 'REVERSAL' });
      expect(await ledger.reverseTransaction({ txnId: funded.txnId, reason: 'again', idempotencyKey: `rev-${funded.txnId}`, actor: SYS })).toMatchObject({ txnId: rev.txnId, created: false }); // same key = replay
      await expect(ledger.reverseTransaction({ txnId: funded.txnId, reason: 'again', idempotencyKey: 'other-key', actor: SYS })).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
      await expect(ledger.reverseTransaction({ txnId: rev.txnId, reason: 'undo undo', idempotencyKey: 'k3', actor: SYS })).rejects.toMatchObject({ code: 'CANNOT_REVERSE_A_REVERSAL' });
      await expectIntegrityOk();
    });

    it('a reversal that would overdraw a protected balance is refused cleanly (money already spent)', async () => {
      const c = await newCustomer('9600000018');
      const funded = await fund(c.userId, 100);
      await hold(c.userId, 100); // the credited money is now held, available is 0
      await expect(ledger.reverseTransaction({ txnId: funded.txnId, reason: 'oops', idempotencyKey: `rev2-${funded.txnId}`, actor: SYS })).rejects.toMatchObject({ code: 'LEDGER_BALANCE_CONSTRAINT' });
      expect(await bal(c.userId)).toEqual({ available: 0, held: 100 });
      await expectIntegrityOk();
    });

    it('test funds are impossible in production', async () => {
      const config = t.app.get<AppConfig>(APP_CONFIG);
      const prodLedger = new LedgerService({ ...config, isProduction: true } as AppConfig, t.app.get(UnitOfWork), t.app.get(LedgerPoster), t.app.get(Clock), t.app.get(OutboxService));
      await expect(prodLedger.creditDevTestFunds({ customerId: uuidv7(), amount: inr(1), paymentRef: 'x', idempotencyKey: 'prod-k', actor: SYS })).rejects.toMatchObject({ code: 'DEV_ONLY' });
    });
  });

  // =====================================================================================================
  describe('wallet API (customer-facing)', () => {
    it('shows available vs held and a labelled statement, newest first, paginated; isolated per customer', async () => {
      const a = await newCustomer('9600000019');
      const b = await newCustomer('9600000020');
      await fund(a.userId, 1000);
      await fund(b.userId, 77);
      const h = await hold(a.userId, 200);

      const wallet = await t.http.get('/api/v1/wallet').set(bearer(a.accessToken)).expect(200);
      expect(wallet.body.data).toEqual({ available: { amount_minor: 80000, currency: 'INR' }, held: { amount_minor: 20000, currency: 'INR' } });

      const first = await t.http.get('/api/v1/wallet/transactions').query({ limit: 2 }).set(bearer(a.accessToken)).expect(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.data.map((x: { label: string }) => x.label)).toEqual(['Reserved for a booking', 'Reserved for a booking']); // one entry per account touched
      expect(first.body.data[0]).toMatchObject({ booking_id: h.bookingId, type: 'HOLD_CREATE' });
      const rest = await t.http.get('/api/v1/wallet/transactions').query({ limit: 10, cursor: first.body.meta.next_cursor }).set(bearer(a.accessToken)).expect(200);
      expect(rest.body.data.map((x: { type: string }) => x.type)).toEqual(['DEV_TEST_CREDIT']);
      expect(rest.body.data[0].label).toMatch(/Test funds/);

      const other = await t.http.get('/api/v1/wallet').set(bearer(b.accessToken)).expect(200);
      expect(other.body.data.available.amount_minor).toBe(7700); // never sees someone else's money
      await t.http.get('/api/v1/wallet').expect(401);
    });

    it('a customer with no wallet yet sees zero, and the API offers no way to set a balance', async () => {
      const c = await newCustomer('9600000021');
      const res = await t.http.get('/api/v1/wallet').set(bearer(c.accessToken)).expect(200);
      expect(res.body.data).toEqual({ available: { amount_minor: 0, currency: 'INR' }, held: { amount_minor: 0, currency: 'INR' } });
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        await t.http[method]('/api/v1/wallet').set(bearer(c.accessToken)).send({ available: 999999 }).expect(404);
      }
    });
  });

  // =====================================================================================================
  describe('reconciliation endpoint', () => {
    let finance: AdminSession;
    it('is available to finance (MFA session) and not to customers', async () => {
      finance = await t.loginAdmin({ phone: '9600000090', email: 'finance@example.com', roles: ['FINANCE_OPERATOR'] });
      const ok = await t.http.get('/api/v1/admin/ledger/integrity').set(bearer(finance.accessToken)).expect(200);
      expect(ok.body.data).toMatchObject({ ok: true, violations: [] });
      const customer = await newCustomer('9600000091');
      await t.http.get('/api/v1/admin/ledger/integrity').set(bearer(customer.accessToken)).expect(403);
      await t.http.get('/api/v1/admin/ledger/integrity').expect(401);
    });
  });

  // =====================================================================================================
  describe('conservation of money under randomised, concurrent activity', () => {
    it('after hundreds of mixed operations: integrity holds and not one paisa is created or destroyed', async () => {
      // tiny deterministic PRNG so a failure is reproducible
      let seed = 20261006;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;

      const customers = await Promise.all(Array.from({ length: 5 }, (_, i) => newCustomer(`96000009${i}0`.slice(0, 10))));
      const providers = Array.from({ length: 3 }, () => uuidv7());
      let credited = 0n;
      const open: { holdId: string; amount: bigint }[] = [];

      for (let round = 0; round < 25; round++) {
        const batch: Promise<unknown>[] = [];
        for (let k = 0; k < 8; k++) {
          const c = pick(customers);
          const roll = rnd();
          if (roll < 0.25) {
            const rupees = 50 + Math.floor(rnd() * 500);
            credited += BigInt(rupees * 100);
            batch.push(fund(c.userId, rupees));
          } else if (roll < 0.6) {
            const rupees = 10 + Math.floor(rnd() * 200);
            batch.push(hold(c.userId, rupees).then((h) => open.push({ holdId: h.id, amount: h.amount.minor })).catch((e) => { if (e.code !== 'INSUFFICIENT_FUNDS') throw e; }));
          } else if (open.length > 0) {
            const h = open.splice(Math.floor(rnd() * open.length), 1)[0]!;
            if (rnd() < 0.5) {
              batch.push(ledger.releaseHold({ holdId: h.holdId, reason: 'R', idempotencyKey: `r-${h.holdId}`, actor: SYS }));
            } else {
              const money = Money.of(h.amount, 'INR');
              const bps = pick([0, 500, 1000, 1250, 2000]);
              const { commission, net } = money.splitCommissionBps(bps);
              const refund = rnd() < 0.3 ? money.percentBps(pick([2500, 5000])) : Money.zero('INR');
              const rest = money.subtract(refund);
              const split = rest.splitCommissionBps(bps);
              batch.push(
                ledger.settleHold({
                  holdId: h.holdId,
                  allocations: [
                    { kind: 'CUSTOMER_REFUND', amount: refund },
                    { kind: 'PROVIDER_PAYABLE', providerId: pick(providers), amount: refund.isZero() ? net : split.net },
                    { kind: 'PLATFORM_COMMISSION', amount: refund.isZero() ? commission : split.commission },
                  ],
                  reason: 'S',
                  idempotencyKey: `s-${h.holdId}`,
                  actor: SYS,
                }),
              );
            }
          }
        }
        await Promise.all(batch);
      }

      await expectIntegrityOk();
      // Non-vacuity: the run really did create, release and settle holds (some with refund splits).
      const outcomes = (await t.pool.query("SELECT status, count(*)::int AS n FROM ledger.holds WHERE customer_id = ANY($1) GROUP BY status", [customers.map((c) => c.userId)])).rows;
      const n = (s: string) => outcomes.find((r) => r.status === s)?.n ?? 0;
      expect(n('SETTLED')).toBeGreaterThanOrEqual(5);
      expect(n('RELEASED')).toBeGreaterThanOrEqual(5);
      const refundSplits = await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE txn_type = 'HOLD_SETTLE' AND (audit_metadata::text LIKE '%CUSTOMER_REFUND%')");
      expect(refundSplits).toBeGreaterThanOrEqual(1);
      // Conservation: every paisa credited is exactly where the ledger says it is.
      const totals = await t.pool.query(
        `SELECT COALESCE(SUM(balance_minor) FILTER (WHERE account_type IN ('CUSTOMER_AVAILABLE','CUSTOMER_HELD','PROVIDER_PAYABLE','PLATFORM_COMMISSION')), 0)::text AS liabilities,
                COALESCE(SUM(balance_minor) FILTER (WHERE account_type = 'GATEWAY_CLEARING'), 0)::text AS gateway
           FROM ledger.accounts`,
      );
      // Everything in the system came in through DEV_TEST_CREDIT postings made by THIS file (earlier tests included).
      const allCredits = await t.pool.query("SELECT COALESCE(SUM(e.amount_minor), 0)::text AS total FROM ledger.entries e JOIN ledger.transactions t ON t.id = e.txn_id WHERE t.txn_type = 'DEV_TEST_CREDIT' AND e.direction = 'CREDIT'");
      const reversed = await t.pool.query("SELECT COALESCE(SUM(e.amount_minor), 0)::text AS total FROM ledger.entries e JOIN ledger.transactions t ON t.id = e.txn_id WHERE t.txn_type = 'REVERSAL' AND e.direction = 'DEBIT' AND e.account_id IN (SELECT id FROM ledger.accounts WHERE account_type = 'CUSTOMER_AVAILABLE')");
      expect(BigInt(totals.rows[0].liabilities)).toBe(BigInt(allCredits.rows[0].total) - BigInt(reversed.rows[0].total));
      expect(BigInt(totals.rows[0].gateway)).toBe(BigInt(totals.rows[0].liabilities)); // what we hold at the PSP equals what we owe
      expect(credited > 0n).toBe(true);
    });
  });
});
