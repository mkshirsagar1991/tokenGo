import { AdminSession, TestApp, bootTestApp } from './support/app';
import { PaymentsHarness, paymentsHarness } from './support/payments';

/** The report day is a calendar day in Asia/Kolkata (UTC+5:30), so derive it the same way. */
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

describe('Platform: health, public app config, settings, audit log, reports (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let h: PaymentsHarness;
  let admin: AdminSession;
  let finance: AdminSession;
  let support: AdminSession;
  const bearer = (a: { accessToken: string }) => ({ Authorization: `Bearer ${a.accessToken}` });

  beforeAll(async () => {
    t = await bootTestApp({ PAYMENT_PROVIDER: 'sandbox' });
    h = paymentsHarness(t);
    admin = await t.loginAdmin({ phone: '9810000001', email: 'root@example.test' });
    finance = await t.loginAdmin({ phone: '9810000002', email: 'fin@example.test', roles: ['FINANCE_OPERATOR'] });
    support = await t.loginAdmin({ phone: '9810000003', email: 'sup@example.test', roles: ['SUPPORT_OPERATOR'] });
  });
  afterAll(() => t?.close());

  describe('health', () => {
    it('live and ready answer without authentication and reveal nothing sensitive', async () => {
      const live = await t.http.get('/api/v1/health/live').expect(200);
      expect(live.body.status).toBe('ok');
      const ready = await t.http.get('/api/v1/health/ready').expect(200);
      expect(ready.body).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
      expect(ready.body.outbox.pending).toEqual(expect.any(Number));
      expect(ready.body.outbox).toHaveProperty('oldest_pending_seconds');
      expect(JSON.stringify(ready.body)).not.toMatch(/postgres|password|secret/i);
    });
  });

  describe('public app config', () => {
    it('is public, honest about the payment mode, and only carries settings marked public', async () => {
      const res = await t.http.get('/api/v1/app-config').expect(200);
      const d = res.body.data;
      expect(d.environment).toBe('test');
      expect(d.payments).toMatchObject({ provider: 'sandbox', test_mode: true });
      expect(d.payments.topup_min.amount_minor).toBeGreaterThan(0);
      expect(d.settings['topup.presets_minor']).toEqual([10000, 20000, 50000, 100000, 200000]);
      expect(Object.keys(d.settings)).not.toContain('disputes.operator_limit_minor');
      expect(Object.keys(d.settings)).not.toContain('reviews.window_days');
    });
  });

  describe('settings', () => {
    it('are listed with defaults; a change is validated, versioned, audited, and visible to the public config', async () => {
      const list = await t.http.get('/api/v1/admin/settings').set(bearer(admin)).expect(200);
      const row = (key: string) => list.body.data.find((s: { key: string }) => s.key === key);
      expect(row('support.phone')).toMatchObject({ value: '', customised: false, version: 0, public: true });

      const set = await t.http.put('/api/v1/admin/settings/support.phone').set(bearer(admin)).send({ value: ' +91 80 4000 1234 ' }).expect(200);
      expect(set.body.data).toMatchObject({ value: '+91 80 4000 1234', customised: true, version: 1 });
      const again = await t.http.put('/api/v1/admin/settings/support.phone').set(bearer(admin)).send({ value: '+91 80 4000 9999' }).expect(200);
      expect(again.body.data.version).toBe(2);

      const config = await t.http.get('/api/v1/app-config').expect(200);
      expect(config.body.data.settings['support.phone']).toBe('+91 80 4000 9999');

      const audit = await h.one<{ n: string }>(`SELECT count(*) AS n FROM audit.audit_logs WHERE action = 'settings.changed' AND entity_id = 'support.phone'`);
      expect(Number(audit.n)).toBe(2);
    });

    it('refuses an unknown key and an invalid value with a clear message, changing nothing', async () => {
      const unknown = await t.http.put('/api/v1/admin/settings/payments.live_mode').set(bearer(admin)).send({ value: true }).expect(422);
      expect(unknown.body.detail).toMatch(/Unknown setting/);
      const bad = await t.http.put('/api/v1/admin/settings/topup.presets_minor').set(bearer(admin)).send({ value: [200, 100] }).expect(422);
      expect(bad.body.detail).toMatch(/topup.presets_minor.*increasing|between/);
      const config = await t.http.get('/api/v1/app-config').expect(200);
      expect(config.body.data.settings['topup.presets_minor']).toEqual([10000, 20000, 50000, 100000, 200000]);
    });

    it('is administrators only: support and finance operators cannot read or change settings; anonymous gets 401', async () => {
      await t.http.get('/api/v1/admin/settings').expect(401);
      await t.http.get('/api/v1/admin/settings').set(bearer(support)).expect(403);
      await t.http.put('/api/v1/admin/settings/support.hours').set(bearer(finance)).send({ value: 'always' }).expect(403);
    });
  });

  describe('audit log', () => {
    it('is readable by audit:read holders, filterable, paginated newest-first, and never exposes credentials', async () => {
      const all = await t.http.get('/api/v1/admin/audit-logs?limit=2').set(bearer(admin)).expect(200);
      expect(all.body.data).toHaveLength(2);
      expect(all.body.meta.next_cursor).toEqual(expect.any(String));
      const next = await t.http.get(`/api/v1/admin/audit-logs?limit=2&cursor=${all.body.meta.next_cursor}`).set(bearer(admin)).expect(200);
      expect(next.body.data[0].id < all.body.data[1].id).toBe(true);

      const filtered = await t.http.get('/api/v1/admin/audit-logs?action=settings.*&entity_id=support.phone').set(bearer(admin)).expect(200);
      expect(filtered.body.data).toHaveLength(2);
      expect(filtered.body.data[0].after).toMatchObject({ value: '+91 80 4000 9999' });
      expect(filtered.body.data[0].actor_id).toBe(admin.userId);

      const everything = JSON.stringify((await t.http.get('/api/v1/admin/audit-logs?limit=100').set(bearer(admin)).expect(200)).body);
      expect(everything).not.toContain(admin.password);

      await t.http.get('/api/v1/admin/audit-logs').set(bearer(support)).expect(403); // support has no audit:read
      await t.http.get('/api/v1/admin/audit-logs').expect(401);
    });

    it('rejects malformed filters instead of ignoring them', async () => {
      await t.http.get('/api/v1/admin/audit-logs?actor_id=not-a-uuid').set(bearer(admin)).expect(422);
      await t.http.get('/api/v1/admin/audit-logs?limit=1000').set(bearer(admin)).expect(422);
    });
  });

  describe('reports', () => {
    it('add up what actually happened: a successful top-up shows in the totals and in its day', async () => {
      const c = await h.newCustomer('9810000010');
      await h.fund(c, 50_000);
      await h.fund(c, 25_000);
      const range = `from=${today()}&to=${today()}`;
      const overview = await t.http.get(`/api/v1/admin/reports/overview?${range}`).set(bearer(finance)).expect(200);
      expect(overview.body.data.money.topups_succeeded).toEqual({ amount_minor: 75_000, currency: 'INR', count: 2 });
      expect(overview.body.data.money.refunds_succeeded.amount_minor).toBe(0);
      expect(overview.body.data.accounts.new_users).toBeGreaterThanOrEqual(1);

      const daily = await t.http.get(`/api/v1/admin/reports/daily?${range}`).set(bearer(admin)).expect(200);
      expect(daily.body.data).toHaveLength(1);
      expect(daily.body.data[0]).toMatchObject({ day: today(), topups_succeeded: { amount_minor: 75_000 } });
    });

    it('a day with nothing in it is zero, not missing', async () => {
      const res = await t.http.get('/api/v1/admin/reports/daily?from=2020-01-01&to=2020-01-03').set(bearer(admin)).expect(200);
      expect(res.body.data.map((d: { day: string }) => d.day)).toEqual(['2020-01-01', '2020-01-02', '2020-01-03']);
      for (const d of res.body.data) expect(d.topups_succeeded.amount_minor).toBe(0);
    });

    it('validates the range and the time zone, and is limited to report:read holders', async () => {
      await t.http.get('/api/v1/admin/reports/overview?from=2026-02-30x&to=2026-03-01').set(bearer(admin)).expect(422);
      await t.http.get('/api/v1/admin/reports/overview?from=2026-03-02&to=2026-03-01').set(bearer(admin)).expect(422);
      await t.http.get('/api/v1/admin/reports/overview?from=2024-01-01&to=2026-03-01').set(bearer(admin)).expect(422);
      await t.http.get(`/api/v1/admin/reports/overview?from=${today()}&to=${today()}&tz=Mars/Olympus`).set(bearer(admin)).expect(422);
      await t.http.get(`/api/v1/admin/reports/overview?from=${today()}&to=${today()}`).set(bearer(support)).expect(403);
      await t.http.get(`/api/v1/admin/reports/overview?from=${today()}&to=${today()}`).expect(401);
    });
  });
});
