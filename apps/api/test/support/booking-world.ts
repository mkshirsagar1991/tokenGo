import { LedgerService } from '../../src/modules/wallet-ledger';
import { Money, OutboxDispatcher, uuidv7 } from '../../src/shared-kernel';
import type { AdminSession, TestApp } from './app';

/** The calendar the suites share: Monday 2026-10-12 09:30 IST. */
export const NOW = new Date('2026-10-12T04:00:00Z');
export const inr = (rupees: number) => Money.of(BigInt(Math.round(rupees * 100)), 'INR');
/** IST wall-clock on a given day in October 2026 -> UTC ISO string. (IST = UTC+5:30) */
export const ist = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60_000).toISOString();
};
export const WEEK_9_TO_6 = { working: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })) };

export interface User {
  phone: string;
  userId: string;
  token: string;
  issuedAt: number;
  refreshing?: Promise<void>;
}
export interface Salon {
  owner: User;
  providerId: string;
  locationId: string;
  haircut: string;
  shaving: string;
  riya: { staffId: string; resourceId: string };
  amit: { staffId: string; resourceId: string };
}

/**
 * Builds real salons, customers and bookings through the public HTTP API (the same path the apps use), so a suite can test what
 * happens AFTER a booking exists — notifications, reviews, disputes — without re-deriving the arrangement.
 */
export function bookingWorld(t: TestApp, admin: () => AdminSession, phonePrefix = '96') {
  const ledger = t.app.get(LedgerService);
  const dispatcher = t.app.get(OutboxDispatcher);
  let phoneSeq = 0;

  async function auth(u: User): Promise<{ Authorization: string }> {
    if (t.clock.now().getTime() - u.issuedAt > 10 * 60_000) {
      u.refreshing ??= (async () => {
        const l = await t.login(u.phone);
        u.token = l.accessToken;
        u.issuedAt = t.clock.now().getTime();
      })().finally(() => {
        u.refreshing = undefined;
      });
      await u.refreshing;
    }
    return { Authorization: `Bearer ${u.token}` };
  }
  async function newUser(): Promise<User> {
    const phone = `${phonePrefix}${String(++phoneSeq).padStart(8, '0')}`;
    const l = await t.login(phone);
    return { phone, userId: l.userId, token: l.accessToken, issuedAt: t.clock.now().getTime() };
  }
  async function customer(funds: number): Promise<User> {
    const u = await newUser();
    if (funds > 0) await ledger.creditDevTestFunds({ customerId: u.userId, amount: inr(funds), paymentRef: uuidv7(), idempotencyKey: `fund:${u.userId}`, actor: { type: 'SYSTEM' } });
    return u;
  }
  const get = async (path: string, u: User) => {
    const h = await auth(u); // authenticate FIRST, build the request second (supertest listens when a request is created)
    return t.http.get(`/api/v1${path}`).set(h);
  };
  const post = async (path: string, u: User, body: object = {}, headers: Record<string, string> = {}) => {
    const h = await auth(u);
    return t.http.post(`/api/v1${path}`).set(h).set(headers).send(body);
  };
  const put = async (path: string, u: User, body: object) => {
    const h = await auth(u);
    return t.http.put(`/api/v1${path}`).set(h).send(body);
  };
  const wallet = async (u: User) => {
    const b = await ledger.getBalance(u.userId);
    return { available: Number(b.available.minor) / 100, held: Number(b.held.minor) / 100 };
  };
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await dispatcher.processBatch()).claimed === 0) break;
  };

  async function createSalon(name: string): Promise<Salon> {
    const owner = await newUser();
    const providerId = (await post('/providers', owner, { display_name: name })).body.data.id;
    const locationId = (await post(`/providers/${providerId}/locations`, owner, { name: `${name} — main`, address_line1: '1 Main Rd', city: 'Pune', state: 'MH', postal_code: '411001', latitude: 18.53, longitude: 73.85 })).body.data.id;
    const types = (await t.http.get('/api/v1/categories/salon/service-types')).body.data as { id: string; code: string }[];
    const svc = async (code: string, price: number, dur: number, buf = 0) =>
      (await post(`/providers/${providerId}/services`, owner, { service_type_id: types.find((x) => x.code === code)!.id, name: code, price_minor: price, duration_min: dur, buffer_min: buf })).body.data.id as string;
    const haircut = await svc('haircut', 20000, 30);
    const shaving = await svc('shaving', 10000, 20, 5);
    const staff = async (n: string) => {
      const s = (await post(`/providers/${providerId}/staff`, owner, { location_id: locationId, display_name: n })).body.data;
      return { staffId: s.id as string, resourceId: s.resource_id as string };
    };
    const riya = await staff('Riya');
    const amit = await staff('Amit');
    await put(`/providers/${providerId}/locations/${locationId}/hours`, owner, WEEK_9_TO_6);
    await post(`/providers/${providerId}/submit`, owner);
    await t.http.post(`/api/v1/admin/providers/${providerId}/approve`).set({ Authorization: `Bearer ${admin().accessToken}` }).expect(200);
    return { owner, providerId, locationId, haircut, shaving, riya, amit };
  }

  const book = async (c: User, s: Salon, start: string, extra: { resource?: string; service?: string; key?: string; body?: object } = {}) =>
    post('/appointments', c, { location_id: s.locationId, service_id: extra.service ?? s.haircut, start_at: start, ...(extra.resource ? { resource_id: extra.resource } : {}), ...(extra.body ?? {}) }, { 'Idempotency-Key': extra.key ?? `bk-${uuidv7()}` });
  const bookOk = async (c: User, s: Salon, start: string, extra: Parameters<typeof book>[3] = {}) => {
    const r = await book(c, s, start, extra);
    if (r.status !== 201) throw new Error(`booking failed ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.data as { id: string; reference: string; status: string; price: { amount_minor: number } };
  };
  const act = (action: string, id: string, u: User, body: object = {}) => post(`/appointments/${id}/${action}`, u, body);

  /** Takes a confirmed booking through arrival, start, completion — ready for the customer to confirm or dispute. */
  async function runToCompleted(b: { id: string }, c: User, s: Salon, startsAt: Date) {
    t.clock.set(new Date(startsAt.getTime() - 5 * 60_000)); // inside the check-in window
    const code = (await get(`/appointments/${b.id}/arrival-code`, c)).body.data.pin as string;
    await act('verify-arrival', b.id, s.owner, { pin: code }).then((r) => expect(r.status).toBe(200));
    await act('start', b.id, s.owner).then((r) => expect(r.status).toBe(200));
    await act('complete', b.id, s.owner).then((r) => expect(r.status).toBe(200));
  }

  return { ledger, dispatcher, auth, newUser, customer, get, post, put, wallet, drain, createSalon, book, bookOk, act, runToCompleted };
}
export type BookingWorld = ReturnType<typeof bookingWorld>;
