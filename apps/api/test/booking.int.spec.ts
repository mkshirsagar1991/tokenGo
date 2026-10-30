import { OutboxDispatcher, Money, uuidv7 } from '../src/shared-kernel';
import { AvailabilityService } from '../src/modules/availability';
import { BookingService } from '../src/modules/booking';
import { LedgerIntegrityService, LedgerService } from '../src/modules/wallet-ledger';
import { AdminSession, TestApp, bootTestApp } from './support/app';

const NOW = new Date('2026-10-12T04:00:00Z'); // Monday 09:30 IST
const inr = (rupees: number) => Money.of(BigInt(Math.round(rupees * 100)), 'INR');
/** IST wall-clock on a given day in October 2026 -> UTC ISO string. (IST = UTC+5:30) */
const ist = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60_000).toISOString();
};
const WEEK_9_TO_6 = { working: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })) };

interface User {
  phone: string;
  userId: string;
  token: string;
  issuedAt: number;
  refreshing?: Promise<void>;
}

describe('Booking engine: atomic request, approval, cancellation, arrival, settlement (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let admin: AdminSession;
  let ledger: LedgerService;
  let integrity: LedgerIntegrityService;
  let dispatcher: OutboxDispatcher;
  let phoneSeq = 0;

  // ---------------------------------------------------------------------------------------- helpers ----
  /** Fresh login whenever the (fake) clock has moved past the access-token lifetime. */
  async function auth(u: User): Promise<{ Authorization: string }> {
    if (t.clock.now().getTime() - u.issuedAt > 10 * 60_000) {
      // Single-flight: concurrent callers for the same user must share ONE login (a second OTP request
      // would invalidate the first one's code).
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
    const phone = `97${String(++phoneSeq).padStart(8, '0')}`;
    const l = await t.login(phone);
    return { phone, userId: l.userId, token: l.accessToken, issuedAt: t.clock.now().getTime() };
  }
  async function customer(funds: number): Promise<User> {
    const u = await newUser();
    if (funds > 0) await ledger.creditDevTestFunds({ customerId: u.userId, amount: inr(funds), paymentRef: uuidv7(), idempotencyKey: `fund:${u.userId}`, actor: { type: 'SYSTEM' } });
    return u;
  }
  const get = async (path: string, u: User) => {
    const h = await auth(u);
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
  const count = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0].n as number;
  const drainOutbox = async () => {
    for (let i = 0; i < 10; i++) if ((await dispatcher.processBatch()).claimed === 0) break;
  };
  const expectLedgerOk = async () => expect((await integrity.check()).violations).toEqual([]);
  /** What settlement recorded as owed to the provider for this booking (recorded from the ledger's event, so it needs the outbox drained). */
  const owedFor = async (bookingId: string) => {
    await drainOutbox();
    return (await t.pool.query('SELECT provider_id, net_minor, commission_minor, status FROM settlement.provider_payables WHERE booking_id = $1', [bookingId])).rows;
  };

  interface Salon {
    owner: User;
    providerId: string;
    locationId: string;
    haircut: string;
    shaving: string;
    riya: { staffId: string; resourceId: string };
    amit: { staffId: string; resourceId: string };
  }
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
    await t.http.post(`/api/v1/admin/providers/${providerId}/approve`).set({ Authorization: `Bearer ${admin.accessToken}` }).expect(200);
    return { owner, providerId, locationId, haircut, shaving, riya, amit };
  }
  const book = async (c: User, s: Salon, start: string, extra: { resource?: string; service?: string; key?: string; body?: object } = {}) =>
    post('/appointments', c, { location_id: s.locationId, service_id: extra.service ?? s.haircut, start_at: start, ...(extra.resource ? { resource_id: extra.resource } : {}), ...(extra.body ?? {}) }, { 'Idempotency-Key': extra.key ?? `bk-${uuidv7()}` });
  const bookOk = async (c: User, s: Salon, start: string, extra: Parameters<typeof book>[3] = {}) => (await book(c, s, start, extra).then((r) => (r.status === 201 ? r : Promise.reject(new Error(`booking failed ${r.status}: ${JSON.stringify(r.body)}`)))))!.body.data as { id: string; status: string; funds_status: string; response_deadline_at: string; reference: string; staff_resource_id: string; price: { amount_minor: number; currency: string } };
  const act = (action: string, id: string, u: User, body: object = {}) => post(`/appointments/${id}/${action}`, u, body);

  beforeAll(async () => {
    t = await bootTestApp();
    t.clock.set(NOW);
    ledger = t.app.get(LedgerService);
    integrity = t.app.get(LedgerIntegrityService);
    dispatcher = t.app.get(OutboxDispatcher);
    admin = await t.loginAdmin({ phone: '9700099999', email: 'admin@example.com' });
  });
  afterAll(async () => {
    await t.close();
  });

  // =====================================================================================================
  describe('the complete journey (requirements §39)', () => {
    it('request -> hold -> approve -> arrive -> start -> complete -> confirm -> settle, with exact money at every step', async () => {
      const s = await createSalon('Journey Salon');
      const c = await customer(1000);

      // Request: server prices ₹200, holds it, reserves the slot — all in one step.
      const b = await bookOk(c, s, ist(13, '10:00'));
      expect(b).toMatchObject({ status: 'REQUESTED', funds_status: 'HELD', price: { amount_minor: 20000, currency: 'INR' } });
      expect(b.reference).toMatch(/^TG-[0-9A-Z]{8}$/);
      expect(await wallet(c)).toEqual({ available: 800, held: 200 });
      const deadline = new Date(b.response_deadline_at).getTime();
      expect(deadline).toBe(NOW.getTime() + 30 * 60_000);

      // The slot is now occupied for BOTH customers and the public list.
      const during = (await t.http.get('/api/v1/availability/slots').query({ location_id: s.locationId, service_id: s.haircut, date: '2026-10-13', resource_id: b.staff_resource_id })).body.data.slots as { local_start: string }[];
      expect(during.map((x) => x.local_start.slice(11))).not.toContain('10:00');

      // The provider sees the request and approves it.
      const list = (await get(`/providers/${s.providerId}/appointments?status=REQUESTED`, s.owner)).body.data as { id: string }[];
      expect(list.map((x) => x.id)).toContain(b.id);
      const approved = (await act('approve', b.id, s.owner)).body.data;
      expect(approved).toMatchObject({ status: 'CONFIRMED', funds_status: 'HELD' });
      expect(await wallet(c)).toEqual({ available: 800, held: 200 }); // approval moves no money

      // At the venue, 10 minutes before the appointment.
      t.clock.set(new Date(ist(13, '09:50')));
      const code = (await get(`/appointments/${b.id}/arrival-code`, c).then((r) => (r.status === 200 ? r : Promise.reject(new Error(JSON.stringify(r.body)))))).body.data;
      expect(code.pin).toMatch(/^\d{6}$/);
      expect(code.qr.token).toMatch(/^v1\./);
      const wrong = await act('verify-arrival', b.id, s.owner, { pin: code.pin === '000000' ? '000001' : '000000' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('ARRIVAL_PROOF_INVALID');
      expect((await act('verify-arrival', b.id, s.owner, { qr_token: code.qr.token })).body.data.status).toBe('CUSTOMER_ARRIVED');
      expect((await act('start', b.id, s.owner)).body.data.status).toBe('SERVICE_STARTED');
      const done = (await act('complete', b.id, s.owner)).body.data;
      expect(done).toMatchObject({ status: 'SERVICE_COMPLETED', settlement_status: 'PENDING', funds_status: 'HELD' });
      expect(await wallet(c)).toEqual({ available: 800, held: 200 }); // not paid out until confirmed / window elapses

      // The customer confirms: held ₹200 -> provider payable ₹180 + platform commission ₹20.
      const closed = (await act('confirm-completion', b.id, c)).body.data;
      expect(closed).toMatchObject({ status: 'CLOSED', funds_status: 'SETTLED', settlement_status: 'DONE' });
      expect(await wallet(c)).toEqual({ available: 800, held: 0 });
      const payable = await t.pool.query("SELECT balance_minor FROM ledger.accounts WHERE owner_type = 'PROVIDER' AND owner_id = $1 AND account_type = 'PROVIDER_PAYABLE'", [s.providerId]);
      expect(payable.rows[0].balance_minor).toBe('18000');
      expect((await t.pool.query("SELECT balance_minor FROM ledger.accounts WHERE account_type = 'PLATFORM_COMMISSION'")).rows[0].balance_minor).toBe('2000');

      // Immutable history, in order, and announced through the outbox.
      const events = (await get(`/appointments/${b.id}/events`, c)).body.data as { type: string }[];
      // the wrong PIN attempt is part of the immutable history too (a failed verification is never silent)
      expect(events.map((e) => e.type)).toEqual(['BookingRequested', 'BookingApproved', 'ArrivalVerificationFailed', 'CustomerArrived', 'ServiceStarted', 'ServiceCompleted', 'ServiceSettled']);
      await drainOutbox();
      // ...and settlement recorded exactly what this provider is now owed for it (from the ledger's own event): a payable, NOT a payout.
      expect(await owedFor(b.id)).toEqual([{ provider_id: s.providerId, net_minor: '18000', commission_minor: '2000', status: 'ACCRUED' }]);
      const types = (await t.pool.query('SELECT event_type FROM platform.outbox_events WHERE aggregate_id = $1 ORDER BY id', [b.id])).rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining(['booking.requested', 'booking.approved', 'booking.arrived', 'booking.started', 'booking.completed', 'booking.settled']));
      await expectLedgerOk();
    });
  });

  // =====================================================================================================
  describe('server authority and validation', () => {
    let s: Salon;
    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Validation Salon');
    });

    it('the booking names the stylist it is with: the one the customer chose, and the one the system picked for "any available"', async () => {
      const c = await customer(1000);
      const chosen = await bookOk(c, s, ist(13, '10:00'), { resource: s.amit.resourceId });
      expect(chosen.staff_resource_id).toBe(s.amit.resourceId);
      const asked = (await t.http.get(`/api/v1/appointments/${chosen.id}`).set({ Authorization: `Bearer ${c.token}` }).expect(200)).body.data;
      expect(asked.staff_name).toBe('Amit');

      const any = await bookOk(c, s, ist(13, '12:00'));
      const picked = (await t.http.get(`/api/v1/appointments/${any.id}`).set({ Authorization: `Bearer ${c.token}` }).expect(200)).body.data;
      expect(['Riya', 'Amit']).toContain(picked.staff_name);
    });

    it('rejects client-supplied money/status fields and requires an Idempotency-Key', async () => {
      const c = await customer(1000);
      for (const sneaky of [{ price_minor: 1 }, { amount: 1 }, { status: 'CONFIRMED' }, { commission_bps: 0 }, { total: 0 }, { hold_id: uuidv7() }]) {
        const res = await book(c, s, ist(13, '10:00'), { body: sneaky });
        expect(res.status).toBe(422);
      }
      const noKey = await post('/appointments', c, { location_id: s.locationId, service_id: s.haircut, start_at: ist(13, '10:00') });
      expect(noKey.status).toBe(422);
      expect(await count('SELECT count(*)::int AS n FROM booking.bookings WHERE customer_id = $1', [c.userId])).toBe(0);
    });

    it('validates time, slot, service and location', async () => {
      const c = await customer(1000);
      expect((await book(c, s, '2026-10-13T04:30:30.000Z')).status).toBe(422); // not a whole minute
      expect((await book(c, s, 'tomorrow')).status).toBe(422);
      expect((await book(c, s, ist(12, '09:30'))).body.code).toBe('SLOT_UNAVAILABLE'); // in the past / inside the lead time
      expect((await book(c, s, ist(13, '08:00'))).body.code).toBe('SLOT_UNAVAILABLE'); // before opening
      expect((await book(c, s, ist(13, '10:07'))).body.code).toBe('SLOT_UNAVAILABLE'); // off the 15-minute grid
      expect((await book(c, s, ist(18, '10:00'))).body.code).toBe('SLOT_UNAVAILABLE'); // Sunday: closed
      expect((await book(c, s, ist(13, '10:00'), { service: uuidv7() })).status).toBe(404);
      expect((await post('/appointments', c, { location_id: uuidv7(), service_id: s.haircut, start_at: ist(13, '10:00') }, { 'Idempotency-Key': 'k-unknown-loc-1' })).status).toBe(404);
      expect(await wallet(c)).toEqual({ available: 1000, held: 0 }); // nothing was charged or held
    });

    it('requires authentication and offers no generic status/CRUD routes', async () => {
      await t.http.post('/api/v1/appointments').set('Idempotency-Key', 'k-anon-12345').send({}).expect(401);
      const c = await customer(1000);
      const b = await bookOk(c, s, ist(13, '11:00'));
      for (const method of ['patch', 'put', 'delete'] as const) {
        const h = await auth(c);
        await t.http[method](`/api/v1/appointments/${b.id}`).set(h).send({ status: 'CONFIRMED' }).expect(404);
      }
      expect((await get(`/appointments/${b.id}`, c)).body.data.status).toBe('REQUESTED');
    });

    it('a service from another provider cannot be booked at this location', async () => {
      const other = await createSalon('Other Salon');
      const c = await customer(1000);
      expect((await book(c, s, ist(13, '10:00'), { service: other.haircut })).status).toBe(404);
    });

    it('a free (₹0) service books and settles without touching the ledger', async () => {
      t.clock.set(NOW);
      const free = await createSalon('Free Salon');
      const types = (await t.http.get('/api/v1/categories/salon/service-types')).body.data as { id: string; code: string }[];
      const svc = (await post(`/providers/${free.providerId}/services`, free.owner, { service_type_id: types.find((x) => x.code === 'facial')!.id, name: 'Free consult', price_minor: 0, duration_min: 15 })).body.data.id;
      const c = await customer(0);
      const before = await count('SELECT count(*)::int AS n FROM ledger.transactions');
      const b = await bookOk(c, free, ist(13, '10:00'), { service: svc });
      expect(b).toMatchObject({ status: 'REQUESTED', funds_status: 'NONE' });
      await act('approve', b.id, free.owner);
      t.clock.set(new Date(ist(13, '09:55')));
      await act('verify-arrival', b.id, free.owner, { manual_reason: 'test' });
      await act('start', b.id, free.owner);
      await act('complete', b.id, free.owner);
      expect((await act('confirm-completion', b.id, c)).body.data).toMatchObject({ status: 'CLOSED', funds_status: 'NONE', settlement_status: 'DONE' });
      expect(await count('SELECT count(*)::int AS n FROM ledger.transactions')).toBe(before); // no money moved at any point
      t.clock.set(NOW);
    });
  });

  // =====================================================================================================
  describe('funds and atomicity (critical tests #2, #8, #9)', () => {
    let s: Salon;
    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Atomic Salon');
    });

    it('insufficient funds: clean 409, and NOTHING is persisted (no booking, hold, reservation or posting)', async () => {
      const c = await customer(100);
      const before = { txns: await count('SELECT count(*)::int AS n FROM ledger.transactions'), res: await count("SELECT count(*)::int AS n FROM scheduling.resource_reservations WHERE kind = 'BOOKING'") };
      const res = await book(c, s, ist(13, '10:00'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
      expect(res.body.errors).toMatchObject({ shortfall: { amount_minor: 10000, currency: 'INR' } });
      expect(await count('SELECT count(*)::int AS n FROM booking.bookings WHERE customer_id = $1', [c.userId])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM ledger.transactions')).toBe(before.txns);
      expect(await count("SELECT count(*)::int AS n FROM scheduling.resource_reservations WHERE kind = 'BOOKING'")).toBe(before.res);
      expect(await wallet(c)).toEqual({ available: 100, held: 0 });
    });

    it('if the slot is lost AFTER the funds were held, the hold is rolled back with everything else', async () => {
      const c = await customer(500);
      const availability = t.app.get(AvailabilityService);
      const spy = jest.spyOn(availability, 'reserveFirstFree').mockResolvedValueOnce(null); // someone else took it in the meantime
      const res = await book(c, s, ist(13, '10:00'));
      spy.mockRestore();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SLOT_UNAVAILABLE');
      expect(await wallet(c)).toEqual({ available: 500, held: 0 });
      expect(await count('SELECT count(*)::int AS n FROM ledger.holds WHERE customer_id = $1', [c.userId])).toBe(0);
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE txn_type = 'HOLD_CREATE' AND actor_id = $1", [c.userId])).toBe(0);
      await expectLedgerOk();
    });

    it('if a LATER step fails after hold + reservation succeeded, both are rolled back (never a half-booking)', async () => {
      const c = await customer(500);
      const bookings = t.app.get(BookingService) as unknown as { repo: { insertItem: (...a: unknown[]) => Promise<void> } };
      const spy = jest.spyOn(bookings.repo, 'insertItem').mockRejectedValueOnce(new Error('simulated database failure'));
      const res = await book(c, s, ist(13, '10:30'));
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(await wallet(c)).toEqual({ available: 500, held: 0 });
      expect(await count("SELECT count(*)::int AS n FROM scheduling.resource_reservations WHERE kind = 'BOOKING' AND start_at = $1", [ist(13, '10:30')])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM booking.bookings WHERE customer_id = $1', [c.userId])).toBe(0);
      // and the slot is genuinely free again
      expect((await book(c, s, ist(13, '10:30'))).status).toBe(201);
    });

    it('two requests racing for the SAME wallet funds: exactly one booking succeeds (critical test #2)', async () => {
      const c = await customer(200); // enough for ONE ₹200 haircut
      const results = await Promise.all([book(c, s, ist(14, '09:00')), book(c, s, ist(14, '12:00'))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('INSUFFICIENT_FUNDS');
      expect(await wallet(c)).toEqual({ available: 0, held: 200 });
      expect(await count("SELECT count(*)::int AS n FROM booking.bookings WHERE customer_id = $1", [c.userId])).toBe(1);
      await expectLedgerOk();
    });
  });

  // =====================================================================================================
  describe('concurrency on the schedule (critical tests #1, #3)', () => {
    let s: Salon;
    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Race Salon');
    });

    it('two customers book the SAME stylist at the SAME time: exactly one wins; the loser pays nothing (critical test #1)', async () => {
      const [a, b] = await Promise.all([customer(500), customer(500)]);
      const results = await Promise.all([book(a, s, ist(13, '14:00'), { resource: s.riya.resourceId }), book(b, s, ist(13, '14:00'), { resource: s.riya.resourceId })]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('SLOT_UNAVAILABLE');
      const winnerIsA = results[0]!.status === 201;
      expect(await wallet(winnerIsA ? a : b)).toEqual({ available: 300, held: 200 });
      expect(await wallet(winnerIsA ? b : a)).toEqual({ available: 500, held: 0 }); // the loser's hold was rolled back
      expect(await count("SELECT count(*)::int AS n FROM scheduling.resource_reservations WHERE resource_id = $1 AND status = 'ACTIVE' AND start_at = $2", [s.riya.resourceId, ist(13, '14:00')])).toBe(1);
    });

    it('"any stylist" spreads concurrent bookings over the two stylists; the third request loses', async () => {
      const cs = await Promise.all([customer(500), customer(500), customer(500)]);
      const results = await Promise.all(cs.map((c) => book(c, s, ist(13, '15:00'))));
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
      const stylists = results.filter((r) => r.status === 201).map((r) => r.body.data.staff_resource_id);
      expect(new Set(stylists).size).toBe(2); // different stylists, never the same one twice
      const loserIdx = results.findIndex((r) => r.status === 409);
      expect(await wallet(cs[loserIdx]!)).toEqual({ available: 500, held: 0 });
      await expectLedgerOk();
    });

    it('the same request submitted twice (same Idempotency-Key), even simultaneously, creates ONE booking (critical test #3)', async () => {
      const c = await customer(500);
      const key = 'dup-request-key-1';
      const results = await Promise.all(Array.from({ length: 5 }, () => book(c, s, ist(13, '16:00'), { key })));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(await count('SELECT count(*)::int AS n FROM booking.bookings WHERE customer_id = $1', [c.userId])).toBe(1);
      expect(await wallet(c)).toEqual({ available: 300, held: 200 }); // charged once
      // a sequential replay also returns the original, flagged as a replay
      const again = await book(c, s, ist(13, '16:00'), { key });
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.data.id).toBe(results[0]!.body.data.id);
      // reusing the key for a DIFFERENT request is refused
      expect((await book(c, s, ist(13, '16:30'), { key })).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  // =====================================================================================================
  describe('provider decisions and the response deadline', () => {
    let s: Salon;
    let staffUser: User;
    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Decision Salon');
    });

    it('rejection releases the hold exactly once, frees the slot, and records why', async () => {
      const c = await customer(300);
      const b = await bookOk(c, s, ist(13, '10:00'), { resource: s.riya.resourceId });
      const rejected = (await act('reject', b.id, s.owner, { reason_code: 'STAFF_UNAVAILABLE' })).body.data;
      expect(rejected).toMatchObject({ status: 'PROVIDER_REJECTED', funds_status: 'RELEASED' });
      expect(await wallet(c)).toEqual({ available: 300, held: 0 });
      expect((await act('reject', b.id, s.owner, { reason_code: 'OTHER' })).status).toBe(409); // not twice
      expect((await act('approve', b.id, s.owner)).status).toBe(409); // not after
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE booking_id = $1 AND txn_type = 'HOLD_RELEASE'", [b.id])).toBe(1);
      // the slot is bookable again
      expect((await book(c, s, ist(13, '10:00'), { resource: s.riya.resourceId })).status).toBe(201);
      const events = (await get(`/appointments/${b.id}/events`, c)).body.data as { reason_code: string | null }[];
      expect(events.at(-1)!.reason_code).toBe('STAFF_UNAVAILABLE');
      await expectLedgerOk();
    });

    it('an unanswered request EXPIRES at the deadline, via the outbox, releasing the hold exactly once', async () => {
      const c = await customer(300);
      const b = await bookOk(c, s, ist(13, '11:00'), { resource: s.riya.resourceId });
      await drainOutbox();
      expect((await get(`/appointments/${b.id}`, c)).body.data.status).toBe('REQUESTED'); // the deadline event is not due yet

      t.clock.advanceSeconds(30 * 60 + 5); // past the 30-minute response deadline
      await drainOutbox();
      const after = (await get(`/appointments/${b.id}`, c)).body.data;
      expect(after).toMatchObject({ status: 'EXPIRED', funds_status: 'RELEASED', status_reason: 'PROVIDER_TIMEOUT' });
      expect(await wallet(c)).toEqual({ available: 300, held: 0 });
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE booking_id = $1 AND txn_type = 'HOLD_RELEASE'", [b.id])).toBe(1);
      expect((await act('approve', b.id, s.owner)).status).toBe(409); // too late
      // processing the event again changes nothing
      await t.pool.query("UPDATE platform.outbox_events SET status = 'PENDING' WHERE aggregate_id = $1 AND event_type = 'booking.response_deadline'", [b.id]);
      await drainOutbox();
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE booking_id = $1 AND txn_type = 'HOLD_RELEASE'", [b.id])).toBe(1);
      expect(await count("SELECT count(*)::int AS n FROM booking.booking_events WHERE booking_id = $1 AND event_type = 'BookingExpired'", [b.id])).toBe(1);
    });

    it('approving after the deadline is refused even before the expiry job runs; approving in time then expiring is a no-op', async () => {
      t.clock.set(NOW);
      const c = await customer(300);
      const late = await bookOk(c, s, ist(13, '12:00'), { resource: s.riya.resourceId });
      t.clock.advanceSeconds(31 * 60);
      const res = await act('approve', late.id, s.owner);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RESPONSE_DEADLINE_PASSED');

      t.clock.set(new Date(NOW.getTime() + 24 * 3_600_000)); // fresh day for the second scenario
      const c2 = await customer(300);
      const ok = await bookOk(c2, s, ist(14, '12:00'), { resource: s.amit.resourceId });
      expect((await act('approve', ok.id, s.owner)).body.data.status).toBe('CONFIRMED');
      t.clock.advanceSeconds(31 * 60);
      await drainOutbox();
      expect((await get(`/appointments/${ok.id}`, c2)).body.data.status).toBe('CONFIRMED'); // the deadline job found it already answered
    });

    it('approve and reject racing each other: exactly one decision is applied', async () => {
      t.clock.set(new Date(NOW.getTime() + 48 * 3_600_000));
      const c = await customer(300);
      const b = await bookOk(c, s, ist(15, '10:00'), { resource: s.riya.resourceId });
      const results = await Promise.all([act('approve', b.id, s.owner), act('reject', b.id, s.owner, { reason_code: 'OTHER' })]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const final = (await get(`/appointments/${b.id}`, c)).body.data;
      expect(['CONFIRMED', 'PROVIDER_REJECTED']).toContain(final.status);
      expect(await wallet(c)).toEqual(final.status === 'CONFIRMED' ? { available: 100, held: 200 } : { available: 300, held: 0 });
      await expectLedgerOk();
    });

    it('only authorised provider users may decide: outsiders get 404, customers 404, staff without the permission 403', async () => {
      t.clock.set(new Date(NOW.getTime() + 72 * 3_600_000));
      const c = await customer(300);
      const b = await bookOk(c, s, ist(16, '10:00'), { resource: s.amit.resourceId });
      const stranger = await newUser();
      expect((await act('approve', b.id, stranger)).status).toBe(404);
      expect((await act('approve', b.id, c)).status).toBe(404); // the customer cannot approve their own request
      expect((await act('reject', b.id, stranger, { reason_code: 'OTHER' })).status).toBe(404);

      staffUser = await newUser();
      const invite = (await post(`/providers/${s.providerId}/staff`, s.owner, { location_id: s.locationId, display_name: 'Sam', staff_role: 'STAFF', phone: staffUser.phone })).body.data;
      expect((await post(`/users/me/staff-invitations/${invite.id}/accept`, staffUser)).status).toBe(200);
      expect((await act('approve', b.id, staffUser)).status).toBe(403); // stylists run services, they do not accept bookings
      expect((await act('approve', b.id, s.owner)).status).toBe(200);
    });
  });

  // =====================================================================================================
  describe('cancellation policy (requirements §20)', () => {
    let s: Salon;
    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Cancel Salon');
    });
    const confirmed = async (c: User, start: string, resource: string) => {
      const b = await bookOk(c, s, start, { resource });
      await act('approve', b.id, s.owner);
      return b;
    };
    const payable = async () => BigInt((await t.pool.query("SELECT COALESCE(sum(balance_minor), 0)::text AS n FROM ledger.accounts WHERE owner_id = $1 AND account_type = 'PROVIDER_PAYABLE'", [s.providerId])).rows[0].n);

    it('a pending request can be withdrawn for a full refund at any time', async () => {
      const c = await customer(300);
      const b = await bookOk(c, s, ist(13, '10:00'), { resource: s.riya.resourceId });
      const cancelled = (await act('cancel', b.id, c, { reason_code: 'CHANGE_OF_PLANS' })).body.data;
      expect(cancelled).toMatchObject({ status: 'CUSTOMER_CANCELLED', funds_status: 'RELEASED' });
      expect(await wallet(c)).toEqual({ available: 300, held: 0 });
      expect((await act('cancel', b.id, c)).status).toBe(409); // not twice
    });

    it('with ≥24 h notice the refund is 100 % (hold released)', async () => {
      const c = await customer(300);
      const b = await confirmed(c, ist(15, '10:00'), s.riya.resourceId); // ~72 h ahead
      expect((await get(`/appointments/${b.id}`, c)).body.data.cancellation.refund_if_cancelled_now).toMatchObject({ bps: 10000, amount: { amount_minor: 20000 } });
      expect((await act('cancel', b.id, c)).body.data).toMatchObject({ status: 'CUSTOMER_CANCELLED', funds_status: 'RELEASED' });
      expect(await wallet(c)).toEqual({ available: 300, held: 0 });
    });

    it('with 2–24 h notice the refund is 50 %: ₹100 back, ₹100 fee split provider ₹90 / platform ₹10, one transaction', async () => {
      const c = await customer(300);
      const b = await confirmed(c, ist(13, '16:00'), s.amit.resourceId);
      t.clock.set(new Date(ist(13, '11:00'))); // 5 hours before
      const before = await payable();
      expect((await get(`/appointments/${b.id}`, c)).body.data.cancellation.refund_if_cancelled_now).toMatchObject({ bps: 5000, amount: { amount_minor: 10000 } });
      const cancelled = (await act('cancel', b.id, c)).body.data;
      expect(cancelled).toMatchObject({ status: 'CUSTOMER_CANCELLED', funds_status: 'PARTIAL' });
      expect(await wallet(c)).toEqual({ available: 200, held: 0 }); // 300 - 200 held + 100 refunded
      expect((await payable()) - before).toBe(9000n);
      expect(await owedFor(b.id)).toEqual([{ provider_id: s.providerId, net_minor: '9000', commission_minor: '1000', status: 'ACCRUED' }]); // only the fee the provider kept
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE booking_id = $1 AND txn_type = 'HOLD_SETTLE'", [b.id])).toBe(1);
      await expectLedgerOk();
    });

    it('with < 2 h notice nothing is refunded: the whole ₹200 goes to the provider (₹180) and platform (₹20)', async () => {
      t.clock.set(NOW);
      const c = await customer(300);
      const b = await confirmed(c, ist(13, '17:00'), s.riya.resourceId);
      t.clock.set(new Date(ist(13, '16:00'))); // 1 hour before
      const before = await payable();
      expect((await act('cancel', b.id, c)).body.data).toMatchObject({ status: 'CUSTOMER_CANCELLED', funds_status: 'SETTLED' });
      expect(await wallet(c)).toEqual({ available: 100, held: 0 });
      expect((await payable()) - before).toBe(18000n);
      expect(await owedFor(b.id)).toEqual([{ provider_id: s.providerId, net_minor: '18000', commission_minor: '2000', status: 'ACCRUED' }]);
      await expectLedgerOk();
    });

    it('a provider cancellation always refunds in full, whatever the timing', async () => {
      t.clock.set(NOW);
      const c = await customer(300);
      const b = await confirmed(c, ist(13, '13:00'), s.riya.resourceId);
      t.clock.set(new Date(ist(13, '12:30'))); // 30 minutes before: a customer would get nothing back
      expect((await act('provider-cancel', b.id, s.owner, { reason_code: 'STAFF_UNAVAILABLE' })).body.data).toMatchObject({ status: 'PROVIDER_CANCELLED', funds_status: 'RELEASED' });
      expect(await wallet(c)).toEqual({ available: 300, held: 0 });
      expect((await act('provider-cancel', b.id, s.owner, { reason_code: 'OTHER' })).status).toBe(409);
    });

    it('a no-show is only recordable after the grace period, and follows the configured no-show refund (0 % by default)', async () => {
      t.clock.set(NOW);
      const c = await customer(300);
      const b = await confirmed(c, ist(13, '15:00'), s.amit.resourceId);
      t.clock.set(new Date(ist(13, '15:10'))); // 10 min after the start; grace is 15
      const early = await act('no-show', b.id, s.owner);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('TOO_EARLY_FOR_NO_SHOW');
      t.clock.set(new Date(ist(13, '15:16')));
      expect((await act('no-show', b.id, s.owner)).body.data).toMatchObject({ status: 'NO_SHOW', funds_status: 'SETTLED' });
      expect(await wallet(c)).toEqual({ available: 100, held: 0 });
      await expectLedgerOk();
    });

    it("another customer cannot cancel, and a customer cannot use the provider's cancel", async () => {
      t.clock.set(NOW);
      const c = await customer(300);
      const other = await customer(300);
      const b = await confirmed(c, ist(14, '10:00'), s.riya.resourceId);
      expect((await act('cancel', b.id, other)).status).toBe(404);
      expect((await act('provider-cancel', b.id, c, { reason_code: 'OTHER' })).status).toBe(404);
      expect((await get(`/appointments/${b.id}`, other)).status).toBe(404);
    });
  });

  // =====================================================================================================
  describe('arrival verification (requirements §18)', () => {
    let s: Salon;
    let manager: User;
    let stylist: User;
    let bookingId: string;
    let customerUser: User;
    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Arrival Salon');
      customerUser = await customer(1000);
      const b = await bookOk(customerUser, s, ist(13, '11:00'), { resource: s.riya.resourceId });
      bookingId = b.id;
      manager = await newUser();
      stylist = await newUser();
      for (const [u, role, name] of [[manager, 'MANAGER', 'Meera'], [stylist, 'STAFF', 'Sam']] as const) {
        const inv = (await post(`/providers/${s.providerId}/staff`, s.owner, { location_id: s.locationId, display_name: name, staff_role: role, phone: u.phone })).body.data;
        expect((await post(`/users/me/staff-invitations/${inv.id}/accept`, u)).status).toBe(200);
      }
    });

    it('no code before confirmation or outside the check-in window', async () => {
      expect((await get(`/appointments/${bookingId}/arrival-code`, customerUser)).body.code).toBe('NOT_CONFIRMED');
      await act('approve', bookingId, s.owner);
      t.clock.set(new Date(ist(13, '09:00'))); // two hours before: window opens 30 min before
      expect((await get(`/appointments/${bookingId}/arrival-code`, customerUser)).body.code).toBe('OUTSIDE_CHECK_IN_WINDOW');
      expect((await act('verify-arrival', bookingId, stylist, { pin: '123456' })).body.code).toBe('OUTSIDE_CHECK_IN_WINDOW');
    });

    it('brute-forcing the PIN locks verification after 5 wrong tries — even the right PIN is then refused until the lock expires', async () => {
      t.clock.set(new Date(ist(13, '10:45')));
      const real = (await get(`/appointments/${bookingId}/arrival-code`, customerUser)).body.data.pin as string;
      const wrong = real === '999999' ? '999998' : '999999';
      for (let i = 0; i < 5; i++) expect((await act('verify-arrival', bookingId, stylist, { pin: wrong })).status).toBe(401);
      const locked = await act('verify-arrival', bookingId, stylist, { pin: real });
      expect(locked.status).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      t.clock.advanceSeconds(16 * 60);
      expect((await act('verify-arrival', bookingId, stylist, { pin: real })).body.data.status).toBe('CUSTOMER_ARRIVED');
    });

    it('QR tokens work once for the right booking and fail when expired or taken from another booking', async () => {
      t.clock.set(NOW);
      const s2 = await createSalon('QR Salon');
      const c = await customer(1000);
      const b1 = await bookOk(c, s2, ist(13, '11:00'), { resource: s2.riya.resourceId });
      const b2 = await bookOk(c, s2, ist(13, '11:30'), { resource: s2.riya.resourceId }); // window opens 11:00
      await act('approve', b1.id, s2.owner);
      await act('approve', b2.id, s2.owner);
      t.clock.set(new Date(ist(13, '11:00')));
      const qr1 = (await get(`/appointments/${b1.id}/arrival-code`, c)).body.data.qr.token as string;
      expect((await act('verify-arrival', b2.id, s2.owner, { qr_token: qr1 })).status).toBe(401); // another booking's QR
      t.clock.advanceSeconds(6 * 60); // QR lifetime is 5 minutes
      expect((await act('verify-arrival', b1.id, s2.owner, { qr_token: qr1 })).status).toBe(401);
      const fresh = (await get(`/appointments/${b1.id}/arrival-code`, c)).body.data.qr.token as string;
      expect((await act('verify-arrival', b1.id, s2.owner, { qr_token: fresh })).body.data.status).toBe('CUSTOMER_ARRIVED');
    });

    it('a manager can confirm arrival by hand (audited); a stylist cannot; exactly one proof type per request', async () => {
      t.clock.set(NOW);
      const c = await customer(1000);
      const b = await bookOk(c, s, ist(13, '12:00'), { resource: s.amit.resourceId });
      await act('approve', b.id, s.owner);
      t.clock.set(new Date(ist(13, '11:50')));
      expect((await act('verify-arrival', b.id, stylist, { manual_reason: 'Customer lost phone' })).status).toBe(403);
      expect((await act('verify-arrival', b.id, manager, {})).status).toBe(422);
      expect((await act('verify-arrival', b.id, manager, { pin: '123456', manual_reason: 'x' })).status).toBe(422);
      const ok = await act('verify-arrival', b.id, manager, { manual_reason: 'Customer lost phone' });
      expect(ok.body.data.status).toBe('CUSTOMER_ARRIVED');
      const ev = (await get(`/appointments/${b.id}/events`, c)).body.data as { type: string; reason_code: string | null }[];
      expect(ev.find((e) => e.type === 'CustomerArrived')!.reason_code).toBe('MANUAL_OVERRIDE');
    });

    it('staff of another provider cannot verify arrival; the booking id is not enough', async () => {
      const outsider = await newUser();
      expect((await act('verify-arrival', bookingId, outsider, { pin: '123456' })).status).toBe(404);
    });
  });

  // =====================================================================================================
  describe('service lifecycle and settlement (critical tests #5, #6, #10)', () => {
    let s: Salon;
    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Settle Salon');
    });
    it('enforces the order of service steps and completes exactly once (critical test #6)', async () => {
      const c = await customer(500);
      const b = await bookOk(c, s, ist(13, '10:00'), { resource: s.riya.resourceId });
      expect((await act('start', b.id, s.owner)).status).toBe(409); // not confirmed
      await act('approve', b.id, s.owner);
      expect((await act('start', b.id, s.owner)).status).toBe(409); // not arrived
      expect((await act('complete', b.id, s.owner)).status).toBe(409);
      t.clock.set(new Date(ist(13, '09:55')));
      await act('verify-arrival', b.id, s.owner, { manual_reason: 'test' });
      expect((await act('complete', b.id, s.owner)).status).toBe(409); // not started
      await act('start', b.id, s.owner);
      const results = await Promise.all([act('complete', b.id, s.owner), act('complete', b.id, s.owner), act('complete', b.id, s.owner)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await count("SELECT count(*)::int AS n FROM booking.booking_events WHERE booking_id = $1 AND event_type = 'ServiceCompleted'", [b.id])).toBe(1);
      expect(await count("SELECT count(*)::int AS n FROM platform.outbox_events WHERE aggregate_id = $1 AND event_type = 'booking.settlement_due'", [b.id])).toBe(1);
    });

    it('a service is NEVER completed or paid out just because its scheduled end passed (requirements §16)', async () => {
      t.clock.set(NOW);
      const c = await customer(500);
      const b = await bookOk(c, s, ist(14, '14:00'), { resource: s.riya.resourceId });
      await act('approve', b.id, s.owner);
      t.clock.set(new Date(ist(21, '09:00'))); // a week after the appointment ended
      await drainOutbox();
      await t.app.get(BookingService).sweepOverdue({ graceMinutes: 0 });
      const after = (await get(`/appointments/${b.id}`, c)).body.data;
      expect(after).toMatchObject({ status: 'CONFIRMED', funds_status: 'HELD', settlement_status: 'NOT_DUE' }); // waits for a human to act
      expect(await wallet(c)).toEqual({ available: 300, held: 200 });
    });

    it('the dispute window: settlement happens automatically only AFTER it elapses, exactly once', async () => {
      t.clock.set(new Date(ist(16, '08:00')));
      const c = await customer(500);
      const b = await bookOk(c, s, ist(16, '10:00'), { resource: s.amit.resourceId });
      await act('approve', b.id, s.owner);
      t.clock.set(new Date(ist(16, '09:50')));
      await act('verify-arrival', b.id, s.owner, { manual_reason: 'test' });
      await act('start', b.id, s.owner);
      await act('complete', b.id, s.owner);
      const completed = (await get(`/appointments/${b.id}`, c)).body.data;
      expect(completed).toMatchObject({ status: 'SERVICE_COMPLETED', settlement_status: 'PENDING' });

      t.clock.advanceSeconds(23 * 3600);
      await drainOutbox();
      expect((await get(`/appointments/${b.id}`, c)).body.data.status).toBe('SERVICE_COMPLETED'); // window still open
      expect(await wallet(c)).toEqual({ available: 300, held: 200 });

      t.clock.advanceSeconds(2 * 3600); // past 24 h
      await drainOutbox();
      const closed = (await get(`/appointments/${b.id}`, c)).body.data;
      expect(closed).toMatchObject({ status: 'CLOSED', funds_status: 'SETTLED', settlement_status: 'DONE' });
      expect(await wallet(c)).toEqual({ available: 300, held: 0 });
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE booking_id = $1 AND txn_type = 'HOLD_SETTLE'", [b.id])).toBe(1);
    });

    it('confirming early AND the window event arriving later settles exactly once (critical test #5/#10)', async () => {
      t.clock.set(new Date(ist(19, '08:00')));
      const c = await customer(500);
      const b = await bookOk(c, s, ist(19, '10:00'), { resource: s.riya.resourceId });
      await act('approve', b.id, s.owner);
      t.clock.set(new Date(ist(19, '09:50')));
      await act('verify-arrival', b.id, s.owner, { manual_reason: 'test' });
      await act('start', b.id, s.owner);
      await act('complete', b.id, s.owner);
      const results = await Promise.all([act('confirm-completion', b.id, c), act('confirm-completion', b.id, c)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      t.clock.advanceSeconds(25 * 3600);
      await drainOutbox(); // the delayed settlement event now fires: it must find nothing to do
      expect(await count("SELECT count(*)::int AS n FROM ledger.transactions WHERE booking_id = $1 AND txn_type = 'HOLD_SETTLE'", [b.id])).toBe(1);
      expect(await wallet(c)).toEqual({ available: 300, held: 0 });
      await expectLedgerOk();
    });

    it('SNAPSHOT IMMUNITY: later commission and price changes never alter a booking already requested', async () => {
      t.clock.set(new Date(ist(20, '08:00')));
      const adminNow = await t.reloginAdmin(admin);
      const adminAuth = { Authorization: `Bearer ${adminNow.accessToken}` };
      const c = await customer(1000);
      const b = await bookOk(c, s, ist(20, '10:00'), { resource: s.riya.resourceId });
      await act('approve', b.id, s.owner);

      // The platform doubles its commission to 20 % and the provider raises the price — AFTER the request.
      await t.http.post('/api/v1/admin/commission-rules').set(adminAuth).send({ scope_type: 'PLATFORM', kind: 'PERCENT', percent_bps: 2000 }).expect(201);
      const ownerAuth = await auth(s.owner);
      await t.http.patch(`/api/v1/providers/${s.providerId}/services/${s.haircut}`).set(ownerAuth).send({ price_minor: 50000 }).expect(200);

      t.clock.set(new Date(ist(20, '09:50')));
      await act('verify-arrival', b.id, s.owner, { manual_reason: 'test' });
      await act('start', b.id, s.owner);
      await act('complete', b.id, s.owner);
      const closed = (await act('confirm-completion', b.id, c)).body.data;
      expect(closed.price).toEqual({ amount_minor: 20000, currency: 'INR' }); // still ₹200
      expect(await wallet(c)).toEqual({ available: 800, held: 0 }); // charged ₹200, not ₹500
      const fin = (await t.pool.query('SELECT commission_bps FROM booking.booking_financials WHERE booking_id = $1', [b.id])).rows[0];
      expect(fin.commission_bps).toBe(1000); // the 10 % in force at request time
      const settleTxn = (await t.pool.query("SELECT t.id FROM ledger.transactions t WHERE t.booking_id = $1 AND t.txn_type = 'HOLD_SETTLE'", [b.id])).rows[0].id;
      const lines = (await t.pool.query("SELECT a.account_type, e.amount_minor::int AS amt FROM ledger.entries e JOIN ledger.accounts a ON a.id = e.account_id WHERE e.txn_id = $1 AND e.direction = 'CREDIT'", [settleTxn])).rows;
      expect(Object.fromEntries(lines.map((l) => [l.account_type, l.amt]))).toEqual({ PROVIDER_PAYABLE: 18000, PLATFORM_COMMISSION: 2000 });

      // A NEW booking now uses the new price and the new 20 % commission.
      const later = await bookOk(c, s, ist(20, '12:00'), { resource: s.riya.resourceId });
      expect(later.price).toEqual({ amount_minor: 50000, currency: 'INR' });
      const fin2 = (await t.pool.query('SELECT gross_minor::int AS gross, commission_bps FROM booking.booking_financials WHERE booking_id = $1', [later.id])).rows[0];
      expect(fin2).toEqual({ gross: 50000, commission_bps: 2000 });
      expect(await wallet(c)).toEqual({ available: 300, held: 500 });
    });
  });

  // =====================================================================================================
  describe('reads, scoping and the sweeper', () => {
    let s: Salon;
    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Reads Salon');
    });

    it('customers see only their own bookings; lists are paginated newest-first', async () => {
      const a = await customer(2000);
      const b = await customer(2000);
      const ids: string[] = [];
      for (const hh of ['09:00', '10:00', '11:00']) ids.push((await bookOk(a, s, ist(14, hh), { resource: s.riya.resourceId })).id);
      await bookOk(b, s, ist(14, '12:00'), { resource: s.riya.resourceId });

      const first = (await get('/appointments?limit=2', a)).body;
      expect(first.data.map((x: { id: string }) => x.id)).toEqual([ids[2], ids[1]]);
      const rest = (await get(`/appointments?limit=2&cursor=${first.meta.next_cursor}`, a)).body;
      expect(rest.data.map((x: { id: string }) => x.id)).toEqual([ids[0]]);
      expect(rest.meta.next_cursor).toBeNull();
      expect((await get(`/appointments/${ids[0]}`, b)).status).toBe(404);
      expect((await get(`/appointments/${ids[0]}/events`, b)).status).toBe(404);
      expect((await get('/appointments?status=NOT_A_STATUS', a)).status).toBe(422);
      await t.http.get('/api/v1/appointments').expect(401);
    });

    it('provider lists are scoped to the provider (and optionally one location); outsiders and other providers are refused', async () => {
      const c = await customer(1000);
      const mine = await bookOk(c, s, ist(15, '09:00'), { resource: s.amit.resourceId });
      const list = (await get(`/providers/${s.providerId}/appointments`, s.owner)).body.data as { id: string }[];
      expect(list.map((x) => x.id)).toContain(mine.id);
      expect((await get(`/providers/${s.providerId}/appointments`, c)).status).toBe(404);
      const other = await createSalon('Other Reads Salon');
      expect((await get(`/providers/${s.providerId}/appointments`, other.owner)).status).toBe(404);
      expect((await get(`/appointments/${mine.id}`, other.owner)).status).toBe(404);
      expect((await get(`/appointments/${mine.id}`, s.owner)).status).toBe(200);
    });

    it('support/admin staff with an MFA session can read any booking; without MFA they cannot', async () => {
      const c = await customer(1000);
      const b = await bookOk(c, s, ist(15, '10:00'), { resource: s.amit.resourceId });
      const support = await t.loginAdmin({ phone: '9700088888', email: 'support@example.com', roles: ['SUPPORT_OPERATOR'] });
      expect((await t.http.get(`/api/v1/appointments/${b.id}`).set({ Authorization: `Bearer ${support.accessToken}` })).status).toBe(200);
      const otpOnly = await t.login('9700088888');
      expect((await t.http.get(`/api/v1/appointments/${b.id}`).set({ Authorization: `Bearer ${otpOnly.accessToken}` })).status).toBe(404); // role without MFA is worthless
    });

    it('the sweeper rescues overdue work even if its outbox event was lost', async () => {
      t.clock.set(NOW);
      const c = await customer(500);
      const b = await bookOk(c, s, ist(16, '09:00'), { resource: s.riya.resourceId });
      await t.pool.query("DELETE FROM platform.outbox_events WHERE aggregate_id = $1 AND event_type = 'booking.response_deadline'", [b.id]); // simulate a lost event
      t.clock.advanceSeconds(45 * 60); // deadline (30 min) + 5 min grace exceeded
      const out = await t.app.get(BookingService).sweepOverdue();
      expect(out.expired).toBeGreaterThanOrEqual(1);
      expect((await get(`/appointments/${b.id}`, c)).body.data).toMatchObject({ status: 'EXPIRED', funds_status: 'RELEASED' });
      expect(await wallet(c)).toEqual({ available: 500, held: 0 });
    });

    it('outbox events for bookings carry identifiers only — no names, phones or notes', async () => {
      const c = await customer(500);
      const b = await bookOk(c, s, ist(16, '12:00'), { resource: s.riya.resourceId, body: { note: 'Please use the side door, ph 9876543210' } });
      const row = (await t.pool.query("SELECT payload FROM platform.outbox_events WHERE aggregate_id = $1 AND event_type = 'booking.requested'", [b.id])).rows[0];
      expect(JSON.stringify(row.payload)).not.toMatch(/side door|9876543210/);
      expect(Object.keys(row.payload).sort()).toEqual(['booking_id', 'customer_id', 'location_id', 'provider_id', 'resource_id']);
    });
  });

  // =====================================================================================================
  describe('whole-system invariants', () => {
    it('after everything above, the ledger is balanced and every booking agrees with its hold', async () => {
      await expectLedgerOk();
      const mismatches = await t.pool.query(
        `SELECT b.id, b.status, b.funds_status, h.status AS hold_status
           FROM booking.bookings b
           JOIN booking.booking_financials f ON f.booking_id = b.id
           JOIN ledger.holds h ON h.id = f.hold_id
          WHERE (b.funds_status = 'HELD' AND h.status <> 'ACTIVE')
             OR (b.funds_status = 'RELEASED' AND h.status <> 'RELEASED')
             OR (b.funds_status IN ('SETTLED', 'PARTIAL') AND h.status <> 'SETTLED')`,
      );
      expect(mismatches.rows).toEqual([]);
      // no ACTIVE reservation without a live booking, and no live booking without its reservation
      const orphan = await t.pool.query(
        `SELECT r.id FROM scheduling.resource_reservations r JOIN booking.bookings b ON b.id = r.booking_id
          WHERE r.kind = 'BOOKING' AND r.status = 'ACTIVE' AND b.status IN ('PROVIDER_REJECTED','EXPIRED','CUSTOMER_CANCELLED','PROVIDER_CANCELLED','NO_SHOW')`,
      );
      expect(orphan.rows).toEqual([]);
      const unreserved = await t.pool.query(
        `SELECT b.id FROM booking.bookings b JOIN scheduling.resource_reservations r ON r.id = b.reservation_id
          WHERE b.status IN ('REQUESTED','CONFIRMED','CUSTOMER_ARRIVED','SERVICE_STARTED','SERVICE_COMPLETED') AND r.status <> 'ACTIVE'`,
      );
      expect(unreserved.rows).toEqual([]);
    });
  });

  // =====================================================================================================
  describe('several services in one booking (a haircut + shaving + a facial; a car wash + a tyre change)', () => {
    let s: Salon;
    let facial: string;
    const ids = () => [s.haircut, s.shaving, facial];
    const bookMany = (c: User, serviceIds: string[], start: string, extra: { resource?: string; key?: string } = {}) =>
      post('/appointments', c, { location_id: s.locationId, service_ids: serviceIds, start_at: start, ...(extra.resource ? { resource_id: extra.resource } : {}) }, { 'Idempotency-Key': extra.key ?? `bk-${uuidv7()}` });
    const slotsFor = (serviceIds: string[], date = '2026-10-13', resource?: string) =>
      t.http.get('/api/v1/availability/slots').query({ location_id: s.locationId, service_ids: serviceIds.join(','), date, ...(resource ? { resource_id: resource } : {}) });
    const setSkills = async (staffId: string, serviceIds: string[]) => expect((await put(`/providers/${s.providerId}/staff/${staffId}/services`, s.owner, { service_ids: serviceIds })).status).toBe(200);
    const localStarts = (res: { body: { data: { slots: { local_start: string }[] } } }) => res.body.data.slots.map((x) => x.local_start.slice(11));

    beforeAll(async () => {
      t.clock.set(NOW);
      s = await createSalon('Multi Salon');
      const types = (await t.http.get('/api/v1/categories/salon/service-types')).body.data as { id: string; code: string }[];
      // haircut ₹200 / 30 min, shaving ₹100 / 20 min + 5 buffer, facial ₹500 / 40 min + 10 buffer
      facial = (await post(`/providers/${s.providerId}/services`, s.owner, { service_type_id: types.find((x) => x.code === 'facial')!.id, name: 'facial', price_minor: 50000, duration_min: 40, buffer_min: 10 })).body.data.id;
    });

    it('the slot list is for the WHOLE visit: services listed, total price and time added up, the block is as long as all of them', async () => {
      const r = await slotsFor(ids());
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(d.services.map((x: { name: string }) => x.name)).toEqual(['haircut', 'shaving', 'facial']);
      expect(d.service.name).toBe('haircut + shaving + facial');
      // 30 + (20+5) + (40+10) = 105 minutes of calendar: 95 with the person, then 10 minutes to reset
      expect(d.total).toEqual({ duration_min: 95, price: { amount_minor: 80000, currency: 'INR' } });
      expect(new Date(d.slots[0].end_at).getTime() - new Date(d.slots[0].start_at).getTime()).toBe(95 * 60_000);
      // closing time is 18:00: the visit (and its reset) must fit, so the last start is 16:15 (16:15 + 105 min = 18:00)
      const starts = localStarts(r);
      expect(starts[0]).toBe('09:00');
      expect(starts[starts.length - 1]).toBe('16:15');
    });

    it('one service through service_ids behaves exactly like the original service_id', async () => {
      const a = await t.http.get('/api/v1/availability/slots').query({ location_id: s.locationId, service_id: s.haircut, date: '2026-10-13' });
      const b = await slotsFor([s.haircut]);
      expect(b.body.data.slots).toEqual(a.body.data.slots);
      expect(b.body.data.total.price.amount_minor).toBe(20000);
    });

    it('books all of them together: ONE hold of the total, one immutable line per service in order, one block of time', async () => {
      const c = await customer(2000);
      const res = await bookMany(c, ids(), ist(13, '10:00'));
      expect(res.status).toBe(201);
      const b = res.body.data;
      expect(b).toMatchObject({ status: 'REQUESTED', funds_status: 'HELD', price: { amount_minor: 80000, currency: 'INR' } });
      expect(b.service.name).toBe('haircut + shaving + facial');
      expect(b.services.map((x: { name: string }) => x.name)).toEqual(['haircut', 'shaving', 'facial']);
      expect(b.services.map((x: { price: { amount_minor: number } }) => x.price.amount_minor)).toEqual([20000, 10000, 50000]);
      expect(new Date(b.schedule.end_at).getTime() - new Date(b.schedule.start_at).getTime()).toBe(95 * 60_000);
      expect(await wallet(c)).toEqual({ available: 1200, held: 800 }); // ONE hold for the whole visit

      const items = (await t.pool.query('SELECT name, price_minor, duration_min, buffer_min, position FROM booking.booking_items WHERE booking_id = $1 ORDER BY position', [b.id])).rows;
      expect(items.map((i) => [i.name, i.price_minor, i.position])).toEqual([['haircut', '20000', 0], ['shaving', '10000', 1], ['facial', '50000', 2]]);
      expect((await t.pool.query('SELECT gross_minor FROM booking.booking_financials WHERE booking_id = $1', [b.id])).rows[0].gross_minor).toBe('80000');
      // the stylist is blocked for the whole 105 minutes, not just for the first service
      const block = (await t.pool.query('SELECT (EXTRACT(EPOCH FROM (r.end_at - r.start_at)) / 60)::int AS minutes FROM scheduling.resource_reservations r JOIN booking.bookings k ON k.reservation_id = r.id WHERE k.id = $1', [b.id])).rows[0];
      expect(block.minutes).toBe(105);
      // reading it back (the list and the detail the apps use) shows the same services
      expect((await get(`/appointments/${b.id}`, c)).body.data.services).toHaveLength(3);
      await expectLedgerOk();
    });

    it('the whole visit is paid for and settled as ONE: provider ₹720, platform ₹80', async () => {
      const c = await customer(2000);
      const b = (await bookMany(c, ids(), ist(14, '10:00'))).body.data;
      await act('approve', b.id, s.owner);
      t.clock.set(new Date(ist(14, '09:55')));
      await act('verify-arrival', b.id, s.owner, { manual_reason: 'test' });
      await act('start', b.id, s.owner);
      await act('complete', b.id, s.owner);
      expect((await act('confirm-completion', b.id, c)).body.data).toMatchObject({ status: 'CLOSED', funds_status: 'SETTLED' });
      expect(await wallet(c)).toEqual({ available: 1200, held: 0 });
      expect(await owedFor(b.id)).toEqual([{ provider_id: s.providerId, net_minor: '72000', commission_minor: '8000', status: 'ACCRUED' }]);
      t.clock.set(NOW);
      await expectLedgerOk();
    });

    it('the stylist stays blocked for the whole visit: a later booking cannot start inside it, but can start right after', async () => {
      const c = await customer(3000);
      const first = (await bookMany(c, ids(), ist(15, '10:00'), { resource: s.riya.resourceId })).body.data; // 10:00 -> 11:45 incl. reset
      expect(first.status).toBe('REQUESTED');
      const inside = await book(c, s, ist(15, '11:30'), { resource: s.riya.resourceId });
      expect(inside.status).toBe(409);
      expect(inside.body.code).toBe('SLOT_UNAVAILABLE');
      expect((await book(c, s, ist(15, '11:45'), { resource: s.riya.resourceId })).status).toBe(201);
    });

    it('only a stylist who can do EVERY chosen service is offered (and nobody, if nobody can)', async () => {
      // Amit only does haircuts; Riya does everything
      await setSkills(s.amit.staffId, [s.haircut]);
      const both = await slotsFor([s.haircut, facial], '2026-10-20');
      const names = new Set((both.body.data.slots as { resources: { id: string }[] }[]).flatMap((x) => x.resources.map((r) => r.id)));
      expect([...names]).toEqual([s.riya.resourceId]);
      const onlyHaircut = await slotsFor([s.haircut], '2026-10-20');
      expect(new Set((onlyHaircut.body.data.slots as { resources: { id: string }[] }[]).flatMap((x) => x.resources.map((r) => r.id))).size).toBe(2);

      await setSkills(s.riya.staffId, [s.haircut]);
      expect((await slotsFor([s.haircut, facial], '2026-10-20')).body.data.slots).toEqual([]); // nobody can do both
      // asking to book it anyway is refused cleanly, and nothing is held
      const c = await customer(2000);
      const refused = await bookMany(c, [s.haircut, facial], ist(20, '10:00'));
      expect(refused.status).toBe(409);
      expect(await wallet(c)).toEqual({ available: 2000, held: 0 });

      await setSkills(s.amit.staffId, []);
      await setSkills(s.riya.staffId, []);
    });

    it('not enough money for the TOTAL: a clean 409 and nothing is saved', async () => {
      const c = await customer(500); // enough for the facial alone, not for all three (₹800)
      const before = await count('SELECT count(*)::int AS n FROM booking.bookings');
      const res = await bookMany(c, ids(), ist(16, '10:00'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
      expect(await count('SELECT count(*)::int AS n FROM booking.bookings')).toBe(before);
      expect(await wallet(c)).toEqual({ available: 500, held: 0 });
    });

    it('withdrawing a pending request refunds the whole total', async () => {
      const c = await customer(1000);
      const b = (await bookMany(c, ids(), ist(16, '14:00'))).body.data;
      expect(await wallet(c)).toEqual({ available: 200, held: 800 });
      expect((await act('cancel', b.id, c)).body.data.status).toBe('CUSTOMER_CANCELLED');
      expect(await wallet(c)).toEqual({ available: 1000, held: 0 });
      await expectLedgerOk();
    });

    it('the same retry (same Idempotency-Key) returns the same booking, not a second one', async () => {
      const c = await customer(2000);
      const key = `bk-${uuidv7()}`;
      const a = await bookMany(c, ids(), ist(17, '10:00'), { key });
      const b = await bookMany(c, ids(), ist(17, '10:00'), { key });
      expect(a.status).toBe(201);
      expect([201, 409]).toContain(b.status);
      expect(await wallet(c)).toEqual({ available: 1200, held: 800 });
    });

    it('a service ticked twice counts once; other bad lists are refused', async () => {
      const c = await customer(2000);
      const twice = await bookMany(c, [s.haircut, s.haircut], ist(21, '10:00'));
      expect(twice.status).toBe(201);
      expect(twice.body.data.price.amount_minor).toBe(20000);
      expect(twice.body.data.services).toHaveLength(1);

      expect((await bookMany(c, [], ist(21, '12:00'))).status).toBe(422);
      const tooMany = Array.from({ length: 9 }, () => uuidv7());
      expect((await bookMany(c, tooMany, ist(21, '12:00'))).status).toBe(422);
      expect((await bookMany(c, [s.haircut, uuidv7()], ist(21, '12:00'))).status).toBe(404); // one of them does not exist
      const other = await createSalon('Other Multi Salon');
      expect((await bookMany(c, [s.haircut, other.haircut], ist(21, '12:00'))).status).toBe(404); // two different businesses can't share one visit
    });
  });
});
