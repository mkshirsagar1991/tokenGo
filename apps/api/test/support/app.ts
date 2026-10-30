import type { INestApplication, Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import supertest from 'supertest';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
import { AdminAuthService, SmsSender, base32Decode, hotp, totpStep } from '../../src/modules/identity-access';
import { Clock, FixedClock } from '../../src/shared-kernel';
import { TestSchema, createTestDatabase } from './db';

/** Captures OTPs instead of sending SMS, so tests can complete the login flow. */
export class CapturingSmsSender extends SmsSender {
  readonly sent: { to: string; code: string }[] = [];

  async sendOtp(to: string, code: string): Promise<void> {
    this.sent.push({ to, code });
  }

  lastCodeFor(to: string): string {
    const hit = [...this.sent].reverse().find((m) => m.to === to);
    if (!hit) throw new Error(`No OTP captured for ${to}`);
    return hit.code;
  }
}

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof supertest>;
  schema: TestSchema;
  /** Direct DB access for assertions and for arranging state the API deliberately does not expose. */
  pool: Pool;
  sms: CapturingSmsSender;
  clock: FixedClock;
  login: (phone: string) => Promise<{ userId: string; accessToken: string; refreshToken: string }>;
  /**
   * Arranges a PLATFORM role directly in the database. There is deliberately no public API to mint the
   * first administrator; production bootstraps one through a controlled, audited operation.
   */
  grantPlatformRole: (userId: string, roleCode: string) => Promise<void>;
  /**
   * Provisions a privileged account and signs it in through the REAL flow (password -> enrol TOTP ->
   * activate). Returns a fully MFA-verified session plus what a human would have kept (secret, codes).
   */
  loginAdmin: (opts: { phone: string; email: string; roles?: string[]; password?: string }) => Promise<AdminSession>;
  /** Signs an existing admin in again (password + current TOTP) — advances the clock one step first. */
  reloginAdmin: (admin: AdminSession) => Promise<{ accessToken: string; refreshToken: string }>;
  close: () => Promise<void>;
}

export interface AdminSession {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  secret: Buffer;
  recoveryCodes: string[];
}

const DEFAULT_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  SMS_PROVIDER: 'console',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  OTP_MAX_PER_PHONE_PER_HOUR: '100',
  OTP_MAX_PER_IP_PER_HOUR: '1000',
};

export async function bootTestApp(
  env: Record<string, string> = {},
  opts: { providers?: Provider[] } = {},
): Promise<TestApp> {
  const schema = await createTestDatabase();
  Object.assign(process.env, DEFAULT_ENV, env, { DATABASE_URL: schema.databaseUrl });

  const sms = new CapturingSmsSender();
  const clock = new FixedClock(new Date());

  const moduleRef = await Test.createTestingModule({ imports: [AppModule], providers: opts.providers ?? [] })
    .overrideProvider(SmsSender)
    .useValue(sms)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true }); // webhooks verify signatures over the RAW bytes
  configureApp(app);
  await app.init();

  const http = supertest(app.getHttpServer());
  const pool = new Pool({ connectionString: schema.databaseUrl, max: 3 });

  const login: TestApp['login'] = async (phone) => {
    await http.post('/api/v1/auth/otp/request').send({ phone }).expect(202);
    const e164 = phone.startsWith('+') ? phone : `+91${phone}`;
    const res = await http.post('/api/v1/auth/otp/verify').send({ phone, code: sms.lastCodeFor(e164) }).expect(200);
    return { userId: res.body.user.id, accessToken: res.body.access_token, refreshToken: res.body.refresh_token };
  };

  const grantPlatformRole: TestApp['grantPlatformRole'] = async (userId, roleCode) => {
    await pool.query(
      `INSERT INTO identity.role_assignments (id, user_id, role_id, scope_type, scope_id)
       SELECT gen_random_uuid(), $1, r.id, 'PLATFORM', NULL FROM identity.roles r WHERE r.code = $2`,
      [userId, roleCode],
    );
  };

  const adminService = app.get(AdminAuthService);
  const totpNow = (secret: Buffer) => hotp(secret, totpStep(clock.now().getTime()));

  const loginAdmin: TestApp['loginAdmin'] = async ({ phone, email, roles = ['PLATFORM_ADMIN'], password = 'correct horse battery staple' }) => {
    const { userId } = await adminService.createAdmin({ phone, email, password, roleCodes: roles });
    const step1 = await http.post('/api/v1/auth/admin/login').send({ email, password }).expect(200);
    expect(step1.body.status).toBe('MFA_ENROLLMENT_REQUIRED');
    const enrol = await http.post('/api/v1/auth/admin/mfa/enroll').send({ mfa_token: step1.body.mfa_token }).expect(200);
    const secret = base32Decode(enrol.body.secret_base32);
    const done = await http
      .post('/api/v1/auth/admin/mfa/activate')
      .send({ mfa_token: step1.body.mfa_token, code: totpNow(secret) })
      .expect(200);
    return { userId, email, password, accessToken: done.body.access_token, refreshToken: done.body.refresh_token, secret, recoveryCodes: done.body.recovery_codes };
  };

  const reloginAdmin: TestApp['reloginAdmin'] = async (admin) => {
    clock.advanceSeconds(31); // a TOTP step may be used once; move to the next one
    const step1 = await http.post('/api/v1/auth/admin/login').send({ email: admin.email, password: admin.password }).expect(200);
    const res = await http.post('/api/v1/auth/admin/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: totpNow(admin.secret) }).expect(200);
    return { accessToken: res.body.access_token, refreshToken: res.body.refresh_token };
  };

  return {
    app,
    http,
    schema,
    pool,
    sms,
    clock,
    login,
    grantPlatformRole,
    loginAdmin,
    reloginAdmin,
    close: async () => {
      await app.close();
      await pool.end();
      await schema.drop();
    },
  };
}
