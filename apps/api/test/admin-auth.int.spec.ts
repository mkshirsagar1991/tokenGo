import { AdminAuthService, base32Decode, hotp, totpStep } from '../src/modules/identity-access';
import { TestApp, bootTestApp } from './support/app';

const PASSWORD = 'correct horse battery staple';

describe('Privileged accounts: password + TOTP MFA (integration, real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const code = (secret: Buffer) => hotp(secret, totpStep(t.clock.now().getTime()));
  const login = (email: string, password = PASSWORD) => t.http.post('/api/v1/auth/admin/login').send({ email, password });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('provisioning', () => {
    it('enforces the password policy and unique e-mail, and stores nothing in plaintext', async () => {
      const svc = t.app.get(AdminAuthService);
      await expect(svc.createAdmin({ phone: '9200000001', email: 'weak@example.com', password: 'short', roleCodes: ['PLATFORM_ADMIN'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(svc.createAdmin({ phone: '9200000001', email: 'not-an-email', password: PASSWORD, roleCodes: ['PLATFORM_ADMIN'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const a = await t.loginAdmin({ phone: '9200000002', email: 'store@example.com' });
      await expect(svc.createAdmin({ phone: '9200000003', email: 'STORE@example.com', password: PASSWORD, roleCodes: ['PLATFORM_ADMIN'] })).rejects.toMatchObject({ code: 'ADMIN_EMAIL_TAKEN' });

      const row = (await t.pool.query('SELECT password_hash, email_enc, mfa_secret_enc FROM identity.admin_credentials WHERE user_id = $1', [a.userId])).rows[0];
      expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$/);
      for (const param of ['m=19456', 't=2', 'p=1']) expect(row.password_hash.split('$')[3]?.split(',')).toContain(param);
      expect(row.password_hash).not.toContain(PASSWORD);
      expect(row.email_enc.toString('utf8')).not.toContain('store@example.com');
      expect(row.mfa_secret_enc.toString('utf8')).not.toContain(a.secret.toString('utf8'));
      const audit = await t.pool.query("SELECT action, actor_type FROM audit.audit_logs WHERE action = 'admin.account_created' AND entity_id = $1", [a.userId]);
      expect(audit.rows[0]).toMatchObject({ actor_type: 'SYSTEM' });
    });
  });

  describe('sign-in flow', () => {
    it('first sign-in forces TOTP enrolment, issues recovery codes, and yields an MFA-verified session', async () => {
      const svc = t.app.get(AdminAuthService);
      await svc.createAdmin({ phone: '9200000010', email: 'flow@example.com', password: PASSWORD, roleCodes: ['PLATFORM_ADMIN'] });

      const step1 = await login('flow@example.com').expect(200);
      expect(step1.body.status).toBe('MFA_ENROLLMENT_REQUIRED');

      // The password-step token is NOT an access token.
      await t.http.get('/api/v1/users/me').set(bearer(step1.body.mfa_token)).expect(401);

      const enrol = await t.http.post('/api/v1/auth/admin/mfa/enroll').send({ mfa_token: step1.body.mfa_token }).expect(200);
      expect(enrol.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/TokenGo%3Aflow%40example\.com\?secret=[A-Z2-7]+&issuer=TokenGo/);

      // activating with a wrong code fails and creates no session
      const bad = await t.http.post('/api/v1/auth/admin/mfa/activate').send({ mfa_token: step1.body.mfa_token, code: '000000' }).expect(401);
      expect(bad.body.code).toBe('MFA_INVALID');

      const secret = base32Decode(enrol.body.secret_base32);
      const done = await t.http.post('/api/v1/auth/admin/mfa/activate').send({ mfa_token: step1.body.mfa_token, code: code(secret) }).expect(200);
      expect(done.body.recovery_codes).toHaveLength(8);
      expect(new Set(done.body.recovery_codes).size).toBe(8);

      const me = await t.http.get('/api/v1/users/me').set(bearer(done.body.access_token)).expect(200);
      expect(me.body.data.permissions).toEqual(expect.arrayContaining(['category:manage', 'provider:verify', 'role:assign']));
      await t.http.get('/api/v1/admin/categories').set(bearer(done.body.access_token)).expect(200);

      // enrolling twice is refused
      await t.http.post('/api/v1/auth/admin/mfa/enroll').send({ mfa_token: step1.body.mfa_token }).expect(409);

      // recovery codes are stored only as hashes
      const stored = await t.pool.query('SELECT code_hash FROM identity.mfa_recovery_codes WHERE user_id = (SELECT user_id FROM identity.admin_credentials WHERE email_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1)');
      expect(stored.rowCount).toBe(8);
      for (const c of done.body.recovery_codes) expect(JSON.stringify(stored.rows)).not.toContain(c.replace('-', ''));
    });

    it('later sign-ins need password + code; an already-used TOTP step cannot be replayed', async () => {
      const a = await t.loginAdmin({ phone: '9200000011', email: 'replay@example.com' });
      t.clock.advanceSeconds(31);
      const step1 = await login(a.email).expect(200);
      expect(step1.body.status).toBe('MFA_REQUIRED');
      const c = code(a.secret);
      await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: c }).expect(200);
      const replay = await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: c }).expect(401);
      expect(replay.body.code).toBe('MFA_INVALID');
      // the next time-step is accepted
      t.clock.advanceSeconds(31);
      await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: code(a.secret) }).expect(200);
    });

    it('recovery codes work exactly once', async () => {
      const a = await t.loginAdmin({ phone: '9200000012', email: 'recover@example.com' });
      const first = a.recoveryCodes[0] as string;
      const step1 = await login(a.email).expect(200);
      await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, recovery_code: first }).expect(200);
      await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, recovery_code: first }).expect(401);
      // lowercase / no-dash typing is tolerated
      await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, recovery_code: (a.recoveryCodes[1] as string).toLowerCase() }).expect(200);
      const audit = await t.pool.query("SELECT 1 FROM audit.audit_logs WHERE action = 'admin.mfa_recovery_code_used' AND actor_id = $1", [a.userId]);
      expect(audit.rowCount).toBe(2);
    });

    it('requires exactly one of code / recovery_code', async () => {
      const a = await t.loginAdmin({ phone: '9200000013', email: 'either@example.com' });
      const step1 = await login(a.email).expect(200);
      await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token }).expect(422);
      await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: '123456', recovery_code: 'ABCDE-FGHIJ' }).expect(422);
    });

    it('the MFA step token expires after 5 minutes', async () => {
      const a = await t.loginAdmin({ phone: '9200000014', email: 'expiry@example.com' });
      t.clock.advanceSeconds(31);
      const step1 = await login(a.email).expect(200);
      t.clock.advanceSeconds(301);
      const res = await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: code(a.secret) }).expect(401);
      expect(res.body.code).toBe('MFA_TOKEN_INVALID');
    });

    it('admin sessions are short-lived and survive refresh without losing MFA', async () => {
      const a = await t.loginAdmin({ phone: '9200000015', email: 'session@example.com' });
      const s = await t.pool.query('SELECT expires_at, created_at, mfa_verified_at FROM identity.auth_sessions WHERE user_id = $1', [a.userId]);
      const hours = (s.rows[0].expires_at.getTime() - s.rows[0].created_at.getTime()) / 3_600_000;
      expect(hours).toBeGreaterThan(11);
      expect(hours).toBeLessThan(13);
      expect(s.rows[0].mfa_verified_at).not.toBeNull();

      const refreshed = await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: a.refreshToken }).expect(200);
      await t.http.get('/api/v1/admin/categories').set(bearer(refreshed.body.access_token)).expect(200);
    });
  });

  describe('credential attacks', () => {
    it('gives one generic error for wrong password and unknown e-mail', async () => {
      await t.loginAdmin({ phone: '9200000020', email: 'generic@example.com' });
      const wrong = await login('generic@example.com', 'wrong password here').expect(401);
      const unknown = await login('nobody@example.com').expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.detail).toBe(unknown.body.detail);
    });

    it('locks the account after 5 failures — even the right password fails — until the lock expires', async () => {
      const a = await t.loginAdmin({ phone: '9200000021', email: 'lock@example.com' });
      for (let i = 0; i < 5; i++) await login(a.email, `wrong-password-${i}-xxxx`).expect(401);
      await login(a.email).expect(401); // correct password, but locked
      const audit = await t.pool.query("SELECT action FROM audit.audit_logs WHERE entity_id = $1 AND action LIKE 'admin.%' ORDER BY occurred_at", [a.userId]);
      expect(audit.rows.map((r) => r.action)).toContain('admin.account_locked');

      t.clock.advanceSeconds(16 * 60);
      await login(a.email).expect(200);
    });

    it('throttles TOTP guessing per account', async () => {
      const a = await t.loginAdmin({ phone: '9200000022', email: 'guess@example.com' });
      t.clock.advanceSeconds(31);
      const step1 = await login(a.email).expect(200);
      const wrong = (i: number) => (i % 2 === 0 ? '000000' : '111111');
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: wrong(i) })).status);
      }
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
      expect(statuses).toContain(429);
      // while throttled, even a correct code is refused
      const res = await t.http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: code(a.secret) });
      expect(res.status).toBe(429);
    });
  });

  describe('privileged roles are worthless without MFA (SIM-swap / stolen-OTP defence)', () => {
    it('an OTP-only session of a user who holds PLATFORM_ADMIN gets MFA_REQUIRED, not admin power', async () => {
      const user = await t.login('9200000030'); // OTP login only
      await t.grantPlatformRole(user.userId, 'PLATFORM_ADMIN');
      const me = await t.http.get('/api/v1/users/me').set(bearer(user.accessToken)).expect(200);
      expect(me.body.data.permissions).not.toContain('category:manage');
      expect(me.body.data.permissions).not.toContain('provider:verify');
      const res = await t.http.get('/api/v1/admin/categories').set(bearer(user.accessToken)).expect(403);
      expect(res.body.code).toBe('MFA_REQUIRED');
      await t.http.post('/api/v1/admin/categories').set(bearer(user.accessToken)).send({ code: 'x_cat', name: 'X' }).expect(403);
    });

    it('a plain customer still gets a normal FORBIDDEN (no hint that admin roles exist)', async () => {
      const user = await t.login('9200000031');
      const res = await t.http.get('/api/v1/admin/categories').set(bearer(user.accessToken)).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('revoking the role takes effect immediately for an MFA-verified session', async () => {
      const a = await t.loginAdmin({ phone: '9200000032', email: 'revoke@example.com' });
      await t.http.get('/api/v1/admin/categories').set(bearer(a.accessToken)).expect(200);
      await t.pool.query("UPDATE identity.role_assignments SET revoked_at = now() WHERE user_id = $1", [a.userId]);
      await t.http.get('/api/v1/admin/categories').set(bearer(a.accessToken)).expect(403);
    });
  });
});
