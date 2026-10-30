import { DeletionGuardRegistry, Money, uuidv7 } from '../src/shared-kernel';
import { AdminSession, TestApp, bootTestApp } from './support/app';
import { PaymentsHarness, paymentsHarness } from './support/payments';

const DAY = 86_400;

describe('Identity administration and account deletion (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let h: PaymentsHarness;
  let admin: AdminSession;
  let support: AdminSession;
  const bearer = (a: { accessToken: string }) => ({ Authorization: `Bearer ${a.accessToken}` });
  const status = async (userId: string) => (await h.one<{ status: string }>('SELECT status FROM identity.users WHERE id = $1', [userId])).status;

  beforeAll(async () => {
    t = await bootTestApp({ PAYMENT_PROVIDER: 'sandbox', ACCOUNT_DELETION_GRACE_DAYS: '7' });
    h = paymentsHarness(t);
    admin = await t.loginAdmin({ phone: '9820000001', email: 'root@example.test' });
    support = await t.loginAdmin({ phone: '9820000002', email: 'sup@example.test', roles: ['SUPPORT_OPERATOR'] });
  });
  afterAll(() => t?.close());

  describe('finding and viewing users', () => {
    it('lists newest first with ONLY masked phone numbers, finds a person by id or full phone, and refuses partial search', async () => {
      const a = await t.login('9820000011');
      await t.login('9820000012');

      const list = await t.http.get('/api/v1/admin/users?limit=2').set(bearer(admin)).expect(200);
      expect(list.body.data).toHaveLength(2);
      expect(JSON.stringify(list.body)).not.toMatch(/98200000\d\d/); // no raw phone anywhere
      expect(list.body.data[0].phone_masked).toMatch(/^\+91 ••••• ••\d{3}$/);
      expect(list.body.meta.next_cursor).toEqual(expect.any(String));

      const byId = await t.http.get(`/api/v1/admin/users?query=${a.userId}`).set(bearer(admin)).expect(200);
      expect(byId.body.data.map((u: { id: string }) => u.id)).toEqual([a.userId]);
      const byPhone = await t.http.get('/api/v1/admin/users?query=9820000011').set(bearer(admin)).expect(200);
      expect(byPhone.body.data.map((u: { id: string }) => u.id)).toEqual([a.userId]);
      await t.http.get('/api/v1/admin/users?query=98200').set(bearer(admin)).expect(422); // no enumeration by prefix

      const one = await t.http.get(`/api/v1/admin/users/${a.userId}`).set(bearer(admin)).expect(200);
      expect(one.body.data).toMatchObject({ id: a.userId, status: 'ACTIVE', is_admin_account: false, active_sessions: 1 });
      expect(one.body.data.roles).toEqual([{ code: 'CUSTOMER', scope_type: 'PLATFORM', scope_id: null }]);
    });

    it('is for staff only: anonymous 401, an ordinary customer 403', async () => {
      const c = await t.login('9820000013');
      await t.http.get('/api/v1/admin/users').expect(401);
      await t.http.get('/api/v1/admin/users').set(bearer(c)).expect(403);
    });
  });

  describe('suspend / reinstate', () => {
    it('locks the person out immediately, is audited with the reason, and can be undone', async () => {
      const c = await t.login('9820000021');
      await t.http.get('/api/v1/users/me').set(bearer(c)).expect(200);

      const res = await t.http.post(`/api/v1/admin/users/${c.userId}/suspend`).set(bearer(admin)).send({ reason: 'Abusive messages to salons' }).expect(200);
      expect(res.body.data.status).toBe('SUSPENDED');
      await t.http.get('/api/v1/users/me').set(bearer(c)).expect(401); // the session was revoked at once
      await t.http.post('/api/v1/auth/otp/request').send({ phone: '9820000021' }).expect(202);
      await t.http.post('/api/v1/auth/otp/verify').send({ phone: '9820000021', code: t.sms.lastCodeFor('+919820000021') }).expect(403); // ACCOUNT_DISABLED
      const audit = await h.one<{ reason: string }>(`SELECT metadata->>'reason' AS reason FROM audit.audit_logs WHERE action = 'user.suspended' AND entity_id = $1`, [c.userId]);
      expect(audit.reason).toBe('Abusive messages to salons');

      await t.http.post(`/api/v1/admin/users/${c.userId}/reinstate`).set(bearer(admin)).expect(200);
      expect((await t.login('9820000021')).userId).toBe(c.userId);
    });

    it('cannot suspend yourself, cannot suspend a non-active account, needs a reason, and is not available to support operators', async () => {
      const c = await t.login('9820000022');
      await t.http.post(`/api/v1/admin/users/${admin.userId}/suspend`).set(bearer(admin)).send({ reason: 'testing' }).expect(403);
      await t.http.post(`/api/v1/admin/users/${c.userId}/suspend`).set(bearer(admin)).send({}).expect(422);
      await t.http.post(`/api/v1/admin/users/${c.userId}/suspend`).set(bearer(support)).send({ reason: 'not allowed' }).expect(403);
      await t.http.post(`/api/v1/admin/users/${c.userId}/reinstate`).set(bearer(admin)).expect(409); // not suspended
    });
  });

  describe('roles', () => {
    it('lists the role catalogue with permissions, for staff who may read it', async () => {
      const res = await t.http.get('/api/v1/admin/roles').set(bearer(support)).expect(200);
      const finance = res.body.data.find((r: { code: string }) => r.code === 'FINANCE_OPERATOR');
      expect(finance).toMatchObject({ scope_type: 'PLATFORM', requires_mfa: true });
      expect(finance.permissions).toEqual(expect.arrayContaining(['payout:operate', 'report:read']));
    });

    it('platform staff roles go only to administrator accounts; never to yourself; every change is audited', async () => {
      const customer = await t.login('9820000031');
      const other = await t.loginAdmin({ phone: '9820000032', email: 'other@example.test', roles: ['SUPPORT_OPERATOR'] });

      const refused = await t.http.post(`/api/v1/admin/users/${customer.userId}/roles`).set(bearer(admin)).send({ role_code: 'PLATFORM_ADMIN', scope_type: 'PLATFORM' }).expect(409);
      expect(refused.body.code).toBe('NOT_AN_ADMIN_ACCOUNT');

      const granted = await t.http.post(`/api/v1/admin/users/${other.userId}/roles`).set(bearer(admin)).send({ role_code: 'FINANCE_OPERATOR', scope_type: 'PLATFORM' }).expect(200);
      expect(granted.body.data.roles.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['SUPPORT_OPERATOR', 'FINANCE_OPERATOR']));
      expect(granted.body.data.is_admin_account).toBe(true);

      await t.http.post(`/api/v1/admin/users/${admin.userId}/roles`).set(bearer(admin)).send({ role_code: 'FINANCE_OPERATOR', scope_type: 'PLATFORM' }).expect(403);
      await t.http.post(`/api/v1/admin/users/${other.userId}/roles/revoke`).set(bearer(admin)).send({ role_code: 'FINANCE_OPERATOR', scope_type: 'PLATFORM' }).expect(200);
      await t.http.post(`/api/v1/admin/users/${other.userId}/roles/revoke`).set(bearer(admin)).send({ role_code: 'FINANCE_OPERATOR', scope_type: 'PLATFORM' }).expect(404); // already gone

      expect(await h.auditCount('user.role_granted', other.userId)).toBe(1);
      expect(await h.auditCount('user.role_revoked', other.userId)).toBe(1);
    });

    it('validates the role, the scope and the target, and only role:assign holders may change roles', async () => {
      const c = await t.login('9820000033');
      const nobody = '00000000-0000-7000-8000-00000000dead';
      await t.http.post(`/api/v1/admin/users/${c.userId}/roles`).set(bearer(admin)).send({ role_code: 'NOPE', scope_type: 'PLATFORM' }).expect(409); // role is checked after the account rule
      await t.http.post(`/api/v1/admin/users/${c.userId}/roles`).set(bearer(admin)).send({ role_code: 'PROVIDER_OWNER', scope_type: 'PROVIDER' }).expect(422); // scope_id required
      await t.http.post(`/api/v1/admin/users/${c.userId}/roles`).set(bearer(admin)).send({ role_code: 'PROVIDER_OWNER', scope_type: 'PROVIDER', scope_id: nobody }).expect(404);
      await t.http.post(`/api/v1/admin/users/${nobody}/roles`).set(bearer(admin)).send({ role_code: 'CUSTOMER', scope_type: 'PLATFORM' }).expect(404);
      await t.http.post(`/api/v1/admin/users/${c.userId}/roles`).set(bearer(support)).send({ role_code: 'CUSTOMER', scope_type: 'PLATFORM' }).expect(403);
    });
  });

  describe('account deletion', () => {
    it('modules register their vetoes', () => {
      expect(t.app.get(DeletionGuardRegistry).names).toEqual(expect.arrayContaining(['booking', 'provider', 'wallet']));
    });

    it('request -> signed out everywhere -> signing in again within the grace period cancels it', async () => {
      const c = await t.login('9820000041');
      const res = await t.http.post('/api/v1/users/me/deletion-request').set(bearer(c)).expect(200);
      expect(Date.parse(res.body.data.due_at) - t.clock.now().getTime()).toBe(7 * DAY * 1000);

      expect(await status(c.userId)).toBe('DEACTIVATED');
      await t.http.get('/api/v1/users/me').set(bearer(c)).expect(401);
      const row = await h.one<{ requested: Date | null; due: Date | null }>('SELECT deletion_requested_at AS requested, deletion_due_at AS due FROM identity.users WHERE id = $1', [c.userId]);
      expect(row.requested).not.toBeNull();
      expect(row.due).not.toBeNull();

      await t.http.post('/api/v1/auth/otp/request').send({ phone: '9820000041' }).expect(202);
      const back = await t.http.post('/api/v1/auth/otp/verify').send({ phone: '9820000041', code: t.sms.lastCodeFor('+919820000041') }).expect(200);
      expect(back.body.user).toMatchObject({ id: c.userId, account_restored: true, is_new: false });
      expect(await status(c.userId)).toBe('ACTIVE');
      const after = await h.one<{ due: Date | null }>('SELECT deletion_due_at AS due FROM identity.users WHERE id = $1', [c.userId]);
      expect(after.due).toBeNull();

      // The scheduled finalisation fires later but finds nothing to do: the person is still here.
      t.clock.advanceSeconds(8 * DAY);
      await h.drain();
      expect(await status(c.userId)).toBe('ACTIVE');
      expect(await h.auditCount('account.deletion_cancelled', c.userId)).toBe(1);
    });

    it('after the grace period the account is anonymised: no phone, no sessions, the number is free again, records stay', async () => {
      const c = await t.login('9820000042');
      await t.http.post('/api/v1/users/me/deletion-request').set(bearer(c)).expect(200);

      t.clock.advanceSeconds(6 * DAY);
      await h.drain();
      expect(await status(c.userId)).toBe('DEACTIVATED'); // not yet due

      t.clock.advanceSeconds(2 * DAY);
      await h.drain();
      const row = await h.one<{ status: string; phone_hash: string; phone_len: number; email: Buffer | null }>('SELECT status, phone_hash, length(phone_enc) AS phone_len, email_enc AS email FROM identity.users WHERE id = $1', [c.userId]);
      expect(row).toMatchObject({ status: 'DELETED', phone_hash: `deleted:${c.userId}`, phone_len: 0, email: null });
      expect(await h.auditCount('account.deleted', c.userId)).toBe(1);
      expect(await h.count('SELECT count(*) AS n FROM identity.auth_sessions WHERE user_id = $1 AND revoked_at IS NULL', [c.userId])).toBe(0);

      // The same phone number can register again — as a brand-new account.
      await t.http.post('/api/v1/auth/otp/request').send({ phone: '9820000042' }).expect(202);
      const again = await t.http.post('/api/v1/auth/otp/verify').send({ phone: '9820000042', code: t.sms.lastCodeFor('+919820000042') }).expect(200);
      expect(again.body.user.is_new).toBe(true);
      expect(again.body.user.id).not.toBe(c.userId);

      // The tombstone shows as deleted to administrators, never as a phone number.
      const fresh = await t.reloginAdmin(admin); // authenticate first, build the request second (see STATUS D9)
      const view = await t.http.get(`/api/v1/admin/users/${c.userId}`).set(bearer(fresh)).expect(200);
      expect(view.body.data).toMatchObject({ status: 'DELETED', phone_masked: 'deleted', roles: [] });
    });

    it('is refused, with reasons a person can act on, while money is in the wallet or a business is active', async () => {
      const funded = await h.newCustomer('9820000043');
      await h.fund(funded, 50_000);
      const blocked = await t.http.post('/api/v1/users/me/deletion-request').set(await h.auth(funded)).expect(409);
      expect(blocked.body.code).toBe('ACCOUNT_DELETION_BLOCKED');
      expect(blocked.body.errors.reasons[0]).toMatch(/wallet still holds ₹500/);
      expect(await status(funded.userId)).toBe('ACTIVE');
      await t.http.get('/api/v1/users/me').set(await h.auth(funded)).expect(200); // still signed in: nothing changed

      const owner = await h.newCustomer('9820000044');
      const created = await t.http.post('/api/v1/providers').set(await h.auth(owner)).send({ display_name: 'Deletion Test Salon' }).expect(201);
      await t.pool.query("UPDATE provider.providers SET status = 'APPROVED' WHERE id = $1", [created.body.data.id]);
      const ownerRes = await t.http.post('/api/v1/users/me/deletion-request').set(await h.auth(owner)).expect(409);
      expect(ownerRes.body.errors.reasons[0]).toMatch(/own a business/);
    });

    it('postpones (and says why) if something started blocking it during the grace period, instead of deleting', async () => {
      const c = await t.login('9820000045');
      await t.http.post('/api/v1/users/me/deletion-request').set(bearer(c)).expect(200);
      // Money arrives after the request (e.g. a late refund): the ledger must never lose it to a deletion.
      await h.ledger.creditDevTestFunds({ customerId: c.userId, amount: Money.of(30_000n, 'INR'), paymentRef: uuidv7(), idempotencyKey: `late:${c.userId}`, actor: { type: 'SYSTEM' } });
      t.clock.advanceSeconds(8 * DAY);
      await h.drain();
      expect(await status(c.userId)).toBe('DEACTIVATED');
      const row = await h.one<{ reason: string }>('SELECT deletion_blocked_reason AS reason FROM identity.users WHERE id = $1', [c.userId]);
      expect(row.reason).toMatch(/wallet still holds ₹300/);
      expect(await h.auditCount('account.deletion_blocked', c.userId)).toBeGreaterThanOrEqual(1);
    });
  });
});
