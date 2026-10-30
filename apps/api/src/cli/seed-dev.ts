import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { configureApp } from '../app.factory';
import { AppModule } from '../app.module';
import { AdminAuthService, SmsSender, base32Decode, hotp, totpStep } from '../modules/identity-access';
import { DatabaseService, Money, uuidv7 } from '../shared-kernel';
import { LedgerService } from '../modules/wallet-ledger';

/**
 * DEVELOPMENT-ONLY demo data (requirements §34). It drives the REAL HTTP API (so every rule, validation and
 * authorization check applies) rather than writing rows behind the application's back.
 *
 * Safety: refuses unless NODE_ENV is development/test AND the database host is local. It creates no
 * payments, wallets or settlements (none exist yet), and no real credentials: demo logins use fictional
 * numbers (OTP appears in this process only), and the demo admin password is generated and printed ONCE.
 *
 *   pnpm --filter @tokengo/api seed:dev
 *
 * Needs the dev dependencies installed (it uses @nestjs/testing to capture OTPs in-process).
 */

// --- guards ---------------------------------------------------------------------------------------------
function assertSafeTarget(): void {
  const env = process.env['NODE_ENV'] ?? 'development';
  if (env === 'production') throw new Error('Refusing to seed demo data: NODE_ENV=production');
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to seed demo data into a non-local database host: ${host}`);
  }
}

class CapturingSms extends SmsSender {
  readonly codes = new Map<string, string>();
  async sendOtp(to: string, code: string): Promise<void> {
    this.codes.set(to, code);
  }
}

// --- tiny HTTP client over the in-process server ------------------------------------------------------------
class Api {
  constructor(private readonly base: string) {}
  async call<T = unknown>(method: string, path: string, token: string | null, body?: unknown, ok: number[] = [200, 201, 202, 204]): Promise<T> {
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!ok.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6];
const shift = (start: string, end: string, days = WEEKDAYS) => days.map((weekday) => ({ weekday, start, end }));

// --- demo catalogue (prices in minor units: 20000 = ₹200.00) ----------------------------------------------------
const SERVICES = [
  { code: 'haircut', name: 'Haircut', price_minor: 20000, duration_min: 30, buffer_min: 0 },
  { code: 'shaving', name: 'Shaving', price_minor: 10000, duration_min: 20, buffer_min: 5 },
  { code: 'hair_coloring', name: 'Hair Coloring', price_minor: 50000, duration_min: 60, buffer_min: 10 },
  { code: 'facial', name: 'Facial', price_minor: 30000, duration_min: 45, buffer_min: 5 },
];

interface SalonSpec {
  owner: string;
  name: string;
  description: string;
  address: { name: string; address_line1: string; city: string; postal_code: string; latitude: number; longitude: number };
  hours: { working: object[]; breaks?: object[] };
  staff: { name: string; skills: string[] | null; schedule?: { working: object[]; breaks?: object[] }; leaveTomorrow?: boolean }[];
}

const SALONS: SalonSpec[] = [
  {
    owner: '9000000011',
    name: 'ABC Salon',
    description: 'Neighbourhood salon in Koregaon Park: cuts, colour and skincare.',
    address: { name: 'ABC Salon — Koregaon Park', address_line1: '12 North Main Road', city: 'Pune', postal_code: '411001', latitude: 18.5362, longitude: 73.8938 },
    hours: { working: shift('09:00', '20:00'), breaks: shift('13:30', '14:15') },
    staff: [
      { name: 'Riya', skills: ['haircut', 'hair_coloring', 'facial'] },
      { name: 'Amit', skills: ['haircut', 'shaving'], schedule: { working: shift('11:00', '20:00'), breaks: shift('15:00', '15:30') } },
      { name: 'Kabir', skills: null /* generalist */, leaveTomorrow: true },
    ],
  },
  {
    owner: '9000000012',
    name: 'XYZ Salon',
    description: 'Family salon in Kothrud. Open on Sundays.',
    address: { name: 'XYZ Salon — Kothrud', address_line1: '4 Paud Road', city: 'Pune', postal_code: '411038', latitude: 18.5074, longitude: 73.8077 },
    hours: { working: shift('10:00', '21:00', [1, 2, 3, 4, 5, 6, 7]) },
    staff: [
      { name: 'Sana', skills: null },
      { name: 'Dev', skills: ['haircut', 'shaving'], schedule: { working: shift('10:00', '16:00', [1, 2, 3, 4, 5, 6, 7]) } },
    ],
  },
  {
    owner: '9000000013',
    name: 'Style Studio',
    description: 'Boutique colour and styling studio in Baner.',
    address: { name: 'Style Studio — Baner', address_line1: '88 Baner Road', city: 'Pune', postal_code: '411045', latitude: 18.5590, longitude: 73.7868 },
    hours: { working: shift('09:30', '19:30'), breaks: shift('13:00', '13:45') },
    staff: [
      { name: 'Meera', skills: ['hair_coloring', 'facial'] },
      { name: 'Raj', skills: ['haircut', 'shaving'] },
      { name: 'Zoya', skills: null, schedule: { working: shift('12:00', '19:30') } },
    ],
  },
];

async function main(): Promise<void> {
  assertSafeTarget();
  process.env['NODE_ENV'] ??= 'development';
  process.env['SMS_PROVIDER'] ??= 'console';

  const sms = new CapturingSms();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SmsSender).useValue(sms).compile();
  const app: INestApplication = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const api = new Api((await app.getUrl()).replace('[::1]', '127.0.0.1'));

  try {
    const pool = app.get(DatabaseService).pool;
    const already = await pool.query("SELECT 1 FROM provider.providers WHERE display_name = ANY($1)", [SALONS.map((s) => s.name)]);
    if (already.rowCount) {
      console.log('Demo providers already exist — nothing to do (seed is idempotent).');
      return;
    }

    const loginOtp = async (phone: string): Promise<string> => {
      await api.call('POST', '/auth/otp/request', null, { phone });
      const code = sms.codes.get(`+91${phone}`)!;
      return (await api.call<{ access_token: string }>('POST', '/auth/otp/verify', null, { phone, code })).access_token;
    };

    // 1) A throw-away MFA-verified admin does the approvals through the real API, then is deactivated.
    const admins = app.get(AdminAuthService);
    const botEmail = `seed-bot-${randomBytes(3).toString('hex')}@demo.tokengo.test`;
    const botPassword = randomBytes(18).toString('base64url');
    const { userId: botId } = await admins.createAdmin({ phone: '9000000099', email: botEmail, password: botPassword, roleCodes: ['PLATFORM_ADMIN'] });
    const step1 = await api.call<{ mfa_token: string }>('POST', '/auth/admin/login', null, { email: botEmail, password: botPassword });
    const enrol = await api.call<{ secret_base32: string }>('POST', '/auth/admin/mfa/enroll', null, { mfa_token: step1.mfa_token });
    const adminToken = (
      await api.call<{ access_token: string }>('POST', '/auth/admin/mfa/activate', null, {
        mfa_token: step1.mfa_token,
        code: hotp(base32Decode(enrol.secret_base32), totpStep(Date.now())),
      })
    ).access_token;

    // 2) Providers, locations, services, staff, schedules.
    const salonTypes = (await api.call<{ data: { id: string; code: string }[] }>('GET', '/categories/salon/service-types', null)).data;
    const typeId = (code: string) => salonTypes.find((t) => t.code === code)!.id;
    const summary: string[] = [];
    const created: { name: string; owner: string; locationId: string; services: Record<string, string>; ownerToken: string }[] = [];

    for (const spec of SALONS) {
      const owner = await loginOtp(spec.owner);
      const provider = (await api.call<{ data: { id: string } }>('POST', '/providers', owner, { display_name: spec.name, description: spec.description })).data.id;
      const location = (await api.call<{ data: { id: string } }>('POST', `/providers/${provider}/locations`, owner, { ...spec.address, state: 'Maharashtra' })).data.id;
      await api.call('PUT', `/providers/${provider}/locations/${location}/hours`, owner, spec.hours);

      const serviceIds: Record<string, string> = {};
      for (const s of SERVICES) {
        serviceIds[s.code] = (
          await api.call<{ data: { id: string } }>('POST', `/providers/${provider}/services`, owner, {
            service_type_id: typeId(s.code),
            name: s.name,
            price_minor: s.price_minor,
            duration_min: s.duration_min,
            buffer_min: s.buffer_min,
          })
        ).data.id;
      }

      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      for (const person of spec.staff) {
        const staff = (await api.call<{ data: { id: string; resource_id: string } }>('POST', `/providers/${provider}/staff`, owner, { location_id: location, display_name: person.name })).data;
        if (person.schedule) await api.call('PUT', `/providers/${provider}/staff/${staff.id}/schedule`, owner, person.schedule);
        if (person.skills) await api.call('PUT', `/providers/${provider}/staff/${staff.id}/services`, owner, { service_ids: person.skills.map((c) => serviceIds[c]) });
        if (person.leaveTomorrow) await api.call('POST', `/providers/${provider}/staff/${staff.id}/exceptions`, owner, { kind: 'CLOSED', start_date: tomorrow, reason: 'Demo: on leave' });
      }

      await api.call('POST', `/providers/${provider}/submit`, owner);
      await api.call('POST', `/admin/providers/${provider}/approve`, adminToken);
      created.push({ name: spec.name, owner: spec.owner, locationId: location, services: serviceIds, ownerToken: owner });
      summary.push(`  ${spec.name.padEnd(14)} owner login ${spec.owner}   ${spec.staff.length} stylists`);
    }

    // 3) Demo customers (accounts only — wallets/bookings arrive with their phases).
    const customers = ['9000000021', '9000000022', '9000000023'];
    const customerTokens: string[] = [];
    for (const phone of customers) customerTokens.push(await loginOtp(phone));

    // 3b) DEVELOPMENT TEST FUNDS, recorded as clearly identified DEV_TEST_CREDIT ledger transactions —
    //     not payments, not real money, impossible in production (the ledger refuses them there).
    const ledger = app.get(LedgerService);
    const me = async (token: string) => (await api.call<{ data: { id: string } }>('GET', '/users/me', token)).data.id;
    for (const token of customerTokens) {
      await ledger.creditDevTestFunds({ customerId: await me(token), amount: Money.of(200_000n, 'INR'), paymentRef: uuidv7(), idempotencyKey: `seed:fund:${await me(token)}`, actor: { type: 'SYSTEM' } });
    }

    // 3c) A few demo bookings, made through the real API against LIVE availability.
    const nextSlot = async (salon: (typeof created)[number], service: string) => {
      const day = (await api.call<{ data: { slots: { start_at: string }[] } }>('GET', `/availability/slots?location_id=${salon.locationId}&service_id=${salon.services[service]}&days=7`, null)).data.slots;
      const earliest = Date.now() + 20 * 3_600_000; // a slot at least ~20 h away keeps the demo stable
      return day.find((x) => new Date(x.start_at).getTime() >= earliest)?.start_at;
    };
    const demoBookings: string[] = [];
    const xyz = created[1]!;
    const style = created[2]!;
    const bookDemo = async (token: string, salon: (typeof created)[number], service: string, approve: boolean) => {
      const start = await nextSlot(salon, service);
      if (!start) return;
      const res = await fetch(`${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1/appointments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': `seed-${uuidv7()}` },
        body: JSON.stringify({ location_id: salon.locationId, service_id: salon.services[service], start_at: start }),
      });
      if (res.status !== 201) return;
      const booking = ((await res.json()) as { data: { id: string; reference: string } }).data;
      if (approve) await api.call('POST', `/appointments/${booking.id}/approve`, salon.ownerToken);
      demoBookings.push(`  ${booking.reference}  ${salon.name} · ${service} · ${start}  ${approve ? 'CONFIRMED' : 'REQUESTED (awaiting provider)'}`);
    };
    await bookDemo(customerTokens[1]!, xyz, 'shaving', true);
    await bookDemo(customerTokens[2]!, style, 'hair_coloring', false);

    // 4) The bot is switched off; a human admin account is created with a one-time generated password.
    await pool.query("UPDATE identity.users SET status = 'DEACTIVATED' WHERE id = $1", [botId]);
    await pool.query('UPDATE identity.role_assignments SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [botId]);
    const demoAdminPassword = randomBytes(18).toString('base64url');
    await admins.createAdmin({ phone: '9000000001', email: 'admin@demo.tokengo.test', password: demoAdminPassword, roleCodes: ['PLATFORM_ADMIN'] });

    console.log('\nDemo data created.\n');
    console.log('Providers (all APPROVED):');
    console.log(summary.join('\n'));
    console.log(`\nCustomers (OTP login; codes appear in the API log in development): ${customers.join(', ')}`);
    console.log('Each customer has ₹2,000 of DEV TEST FUNDS (ledger transactions of type DEV_TEST_CREDIT — not real money).');
    if (demoBookings.length) console.log(`\nDemo bookings:\n${demoBookings.join('\n')}`);
    console.log('\nDemo administrator (printed ONCE — it is not stored anywhere in plain text):');
    console.log('  e-mail:   admin@demo.tokengo.test');
    console.log(`  password: ${demoAdminPassword}`);
    console.log('  First sign-in forces enrolment of an authenticator app (TOTP).\n');
    console.log('Owner/customer phones are fictional; sign in with POST /api/v1/auth/otp/request + /verify.');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
