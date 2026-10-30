import { TestApp, bootTestApp } from './support/app';

const PHONE = '9876543210';
const E164 = '+919876543210';

describe('Authentication (integration, real PostgreSQL)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const requestOtp = (phone = PHONE) => t.http.post('/api/v1/auth/otp/request').send({ phone });
  const verify = (code: string, phone = PHONE) => t.http.post('/api/v1/auth/otp/verify').send({ phone, code });

  describe('OTP login', () => {
    it('registers a new user, returns tokens, and the profile exposes no raw PII', async () => {
      const req = await requestOtp().expect(202);
      expect(req.body.expires_in_seconds).toBe(300);

      const res = await verify(t.sms.lastCodeFor(E164)).expect(200);
      expect(res.body).toMatchObject({ token_type: 'Bearer', user: { is_new: true } });
      expect(res.body.access_token).toEqual(expect.any(String));
      expect(res.body.refresh_token).toEqual(expect.any(String));

      const me = await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${res.body.access_token}`).expect(200);
      expect(me.body.data.id).toBe(res.body.user.id);
      expect(me.body.data.phone_masked).toBe('+91 ••••• ••210');
      expect(me.body.data.permissions).toContain('provider:register');
      expect(JSON.stringify(me.body)).not.toContain('9876543210');
    });

    it('stores phone and OTP only as ciphertext / keyed hashes', async () => {
      const code = t.sms.lastCodeFor(E164);
      const users = await t.pool.query('SELECT phone_hash, phone_enc FROM identity.users');
      expect(users.rowCount).toBe(1);
      expect(users.rows[0].phone_enc.toString('utf8')).not.toContain('9876543210');
      expect(users.rows[0].phone_hash).toMatch(/^[0-9a-f]{64}$/);
      const ch = await t.pool.query('SELECT code_hash FROM identity.otp_challenges');
      for (const row of ch.rows) expect(row.code_hash).not.toContain(code);
    });

    it('logs the same user in on the second login (is_new=false) and writes audit rows', async () => {
      await requestOtp().expect(202);
      const res = await verify(t.sms.lastCodeFor(E164)).expect(200);
      expect(res.body.user.is_new).toBe(false);
      const audit = await t.pool.query('SELECT action, metadata FROM audit.audit_logs ORDER BY occurred_at');
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.registered', 'auth.login']));
      expect(JSON.stringify(audit.rows)).not.toContain('9876543210'); // masked only
    });

    it('rejects a wrong code, counts attempts, and locks the challenge after the maximum', async () => {
      await requestOtp().expect(202);
      const good = t.sms.lastCodeFor(E164);
      const bad = good === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const r = await verify(bad).expect(401);
        expect(r.body.code).toBe('OTP_INVALID');
      }
      // even the CORRECT code is now refused: the challenge is exhausted
      await verify(good).expect(401);
      await requestOtp().expect(202);
      await verify(t.sms.lastCodeFor(E164)).expect(200); // a fresh challenge works
    });

    it('only the newest code is valid', async () => {
      await requestOtp().expect(202);
      const first = t.sms.lastCodeFor(E164);
      await requestOtp().expect(202);
      const second = t.sms.lastCodeFor(E164);
      if (first !== second) await verify(first).expect(401);
      await verify(second).expect(200);
    });

    it('rejects an expired code', async () => {
      await requestOtp().expect(202);
      const code = t.sms.lastCodeFor(E164);
      t.clock.advanceSeconds(301);
      await verify(code).expect(401);
    });

    it('a code cannot be used twice', async () => {
      await requestOtp().expect(202);
      const code = t.sms.lastCodeFor(E164);
      await verify(code).expect(200);
      await verify(code).expect(401);
    });

    it('two simultaneous verifications of one OTP create exactly one session', async () => {
      const phone = '9123456780';
      await requestOtp(phone).expect(202);
      const code = t.sms.lastCodeFor('+919123456780');
      const results = await Promise.all([verify(code, phone), verify(code, phone)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      const winner = results.find((r) => r.status === 200)!;
      const sessions = await t.pool.query('SELECT count(*)::int AS n FROM identity.auth_sessions WHERE user_id = $1', [winner.body.user.id]);
      expect(sessions.rows[0].n).toBe(1);
    });

    it('validates input strictly: bad phone, bad code format, unknown properties', async () => {
      const bad = await requestOtp('12345').expect(422);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
      await verify('12ab56').expect(422);
      const extra = await t.http.post('/api/v1/auth/otp/request').send({ phone: PHONE, role: 'PLATFORM_ADMIN' }).expect(422);
      expect(extra.body.errors.fields.role).toBeDefined();
    });
  });

  describe('problem+json errors and correlation ids', () => {
    it('401 without a token, in RFC 7807 shape with the request id echoed', async () => {
      const res = await t.http.get('/api/v1/users/me').set('X-Request-Id', 'test-correlation-123').expect(401);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.headers['x-request-id']).toBe('test-correlation-123');
      expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED', request_id: 'test-correlation-123' });
    });

    it('rejects a malformed inbound request id and mints its own', async () => {
      const res = await t.http.get('/api/v1/users/me').set('X-Request-Id', 'bad id with spaces!').expect(401);
      expect(res.headers['x-request-id']).not.toBe('bad id with spaces!');
    });

    it('sends security headers and hides the framework', async () => {
      const res = await t.http.get('/api/v1/users/me');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });
  });

  describe('access token handling', () => {
    it('rejects garbage, wrong-key and alg=none tokens', async () => {
      await t.http.get('/api/v1/users/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
        JSON.stringify({ sub: 'x', sid: 'y', iss: 'tokengo', aud: 'tokengo-api', exp: 9999999999 }),
      ).toString('base64url')}.`;
      await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${none}`).expect(401);
    });

    it('rejects an expired access token', async () => {
      const { accessToken } = await t.login('9000000001');
      t.clock.advanceSeconds(901);
      const res = await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });
  });

  describe('sessions: refresh rotation, reuse detection, logout, suspension', () => {
    it('rotates the refresh token; the new pair works', async () => {
      const first = await t.login('9000000002');
      const rotated = await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: first.refreshToken }).expect(200);
      expect(rotated.body.refresh_token).not.toBe(first.refreshToken);
      await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${rotated.body.access_token}`).expect(200);
    });

    it('treats a rapid replay of a just-rotated token as a client retry (409), without revoking', async () => {
      const first = await t.login('9000000003');
      const rotated = await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: first.refreshToken }).expect(200);
      const replay = await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: first.refreshToken }).expect(409);
      expect(replay.body.code).toBe('REFRESH_CONFLICT');
      await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${rotated.body.access_token}`).expect(200);
    });

    it('revokes the WHOLE session when an old refresh token resurfaces later (theft signal)', async () => {
      const first = await t.login('9000000004');
      const rotated = await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: first.refreshToken }).expect(200);
      t.clock.advanceSeconds(60);

      const stolen = await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: first.refreshToken }).expect(401);
      expect(stolen.body.code).toBe('REFRESH_REUSED');

      // the legitimate holder of the NEW tokens is cut off too: the session is dead
      await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: rotated.body.refresh_token }).expect(401);
      const me = await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${rotated.body.access_token}`).expect(401);
      expect(me.body.code).toBe('SESSION_REVOKED');
      const audit = await t.pool.query("SELECT 1 FROM audit.audit_logs WHERE action = 'auth.refresh_reuse_detected'");
      expect(audit.rowCount).toBeGreaterThan(0);
    });

    it('logout revokes the session immediately, even though the access token has not expired', async () => {
      const s = await t.login('9000000005');
      await t.http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${s.accessToken}`).expect(204);
      const res = await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${s.accessToken}`).expect(401);
      expect(res.body.code).toBe('SESSION_REVOKED');
      await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: s.refreshToken }).expect(401);
    });

    it('a user can list and revoke their own sessions but not anyone else\'s', async () => {
      const a = await t.login('9000000006');
      const b = await t.login('9000000007');
      const listA = await t.http.get('/api/v1/auth/sessions').set('Authorization', `Bearer ${a.accessToken}`).expect(200);
      expect(listA.body.data).toHaveLength(1);
      const sessionOfB = (await t.http.get('/api/v1/auth/sessions').set('Authorization', `Bearer ${b.accessToken}`)).body.data[0].id;
      await t.http.delete(`/api/v1/auth/sessions/${sessionOfB}`).set('Authorization', `Bearer ${a.accessToken}`).expect(404);
      await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${b.accessToken}`).expect(200); // untouched
      await t.http.delete(`/api/v1/auth/sessions/${listA.body.data[0].id}`).set('Authorization', `Bearer ${a.accessToken}`).expect(204);
    });

    it('suspending a user blocks their existing tokens immediately', async () => {
      const s = await t.login('9000000008');
      await t.pool.query("UPDATE identity.users SET status = 'SUSPENDED' WHERE id = $1", [s.userId]);
      const res = await t.http.get('/api/v1/users/me').set('Authorization', `Bearer ${s.accessToken}`).expect(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
      await t.http.post('/api/v1/auth/token/refresh').send({ refresh_token: s.refreshToken }).expect(401);
    });
  });

  describe('audit log is append-only (enforced by the database, not the app)', () => {
    it('rejects UPDATE, DELETE and TRUNCATE', async () => {
      await t.login('9000000009');
      await expect(t.pool.query("UPDATE audit.audit_logs SET action = 'tampered'")).rejects.toThrow(/append-only/);
      await expect(t.pool.query('DELETE FROM audit.audit_logs')).rejects.toThrow(/append-only/);
      await expect(t.pool.query('TRUNCATE audit.audit_logs')).rejects.toThrow(/append-only/);
    });
  });
});

describe('OTP throttling (integration)', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  it('limits OTP requests per phone per hour and sets Retry-After', async () => {
    t = await bootTestApp({ OTP_MAX_PER_PHONE_PER_HOUR: '3' });
    for (let i = 0; i < 3; i++) await t.http.post('/api/v1/auth/otp/request').send({ phone: '9555555555' }).expect(202);
    const res = await t.http.post('/api/v1/auth/otp/request').send({ phone: '9555555555' }).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // a different phone is unaffected
    await t.http.post('/api/v1/auth/otp/request').send({ phone: '9555555556' }).expect(202);
  });

  it('enforces a resend cooldown between OTP requests', async () => {
    t = await bootTestApp({ OTP_RESEND_COOLDOWN_SECONDS: '30' });
    await t.http.post('/api/v1/auth/otp/request').send({ phone: '9444444444' }).expect(202);
    const res = await t.http.post('/api/v1/auth/otp/request').send({ phone: '9444444444' }).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    // DB time (created_at default) vs. test clock: advance the test clock past the cooldown
    t.clock.advanceSeconds(31);
    await t.http.post('/api/v1/auth/otp/request').send({ phone: '9444444444' }).expect(202);
  });
});
