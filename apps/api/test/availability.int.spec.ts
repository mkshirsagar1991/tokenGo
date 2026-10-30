import { AdminSession, TestApp, bootTestApp } from './support/app';

interface Session {
  userId: string;
  accessToken: string;
}

const NOW = new Date('2026-10-12T04:00:00Z'); // Monday 09:30 IST
const TUE = '2026-10-13';
const SUN = '2026-10-18';

const PUNE = { name: 'ABC Salon — Koregaon Park', address_line1: '12 North Main Road', city: 'Pune', state: 'Maharashtra', postal_code: '411001', latitude: 18.5362, longitude: 73.8938 };
const NYC = { name: 'ABC Salon — Manhattan', address_line1: '350 Fifth Avenue', city: 'New York', state: 'NY', postal_code: '10118', country: 'US', latitude: 40.7484, longitude: -73.9857, timezone: 'America/New_York' };
const WEEK_9_TO_6 = { working: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })) };

describe('Availability, schedules & the double-booking guard (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let admin: AdminSession;
  let owner: Session;
  let stranger: Session;
  let providerId: string;
  let loc: string;
  let nycLoc: string;
  let haircut: string;
  let shaving: string;
  let riya: { staffId: string; resourceId: string };
  let amit: { staffId: string; resourceId: string };

  const bearer = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const get = (path: string, s: { accessToken: string }) => t.http.get(`/api/v1${path}`).set(bearer(s));
  const post = (path: string, s: { accessToken: string }, body: object = {}) => t.http.post(`/api/v1${path}`).set(bearer(s)).send(body);
  const put = (path: string, s: { accessToken: string }, body: object) => t.http.put(`/api/v1${path}`).set(bearer(s)).send(body);
  const del = (path: string, s: { accessToken: string }) => t.http.delete(`/api/v1${path}`).set(bearer(s));

  const slotsRes = (q: Record<string, string | number>) => t.http.get('/api/v1/availability/slots').query({ location_id: loc, service_id: haircut, ...q });
  const times = async (q: Record<string, string | number>) => ((await slotsRes(q).expect(200)).body.data.slots as { local_start: string }[]).map((s) => s.local_start.slice(11));

  async function resetSchedule() {
    await t.pool.query('DELETE FROM scheduling.availability_exceptions');
    await t.pool.query('DELETE FROM scheduling.availability_rules WHERE resource_id IS NOT NULL');
    await t.pool.query("DELETE FROM scheduling.resource_reservations");
    await t.pool.query("DELETE FROM catalog.resource_services");
    await t.pool.query("DELETE FROM scheduling.booking_policies WHERE scope_type = 'PROVIDER'");
    await put(`/providers/${providerId}/locations/${loc}/hours`, owner, WEEK_9_TO_6).expect(200);
  }

  beforeAll(async () => {
    t = await bootTestApp();
    t.clock.set(NOW);
    admin = await t.loginAdmin({ phone: '9400000001', email: 'admin@example.com' });
    owner = await t.login('9400000002');
    stranger = await t.login('9400000003');

    providerId = (await post('/providers', owner, { display_name: 'ABC Salon' }).expect(201)).body.data.id;
    loc = (await post(`/providers/${providerId}/locations`, owner, PUNE).expect(201)).body.data.id;
    nycLoc = (await post(`/providers/${providerId}/locations`, owner, NYC).expect(201)).body.data.id;
    const types = (await t.http.get('/api/v1/categories/salon/service-types')).body.data as { id: string; code: string }[];
    haircut = (await post(`/providers/${providerId}/services`, owner, { service_type_id: types.find((x) => x.code === 'haircut')!.id, name: 'Haircut', price_minor: 20000, duration_min: 30 }).expect(201)).body.data.id;
    shaving = (await post(`/providers/${providerId}/services`, owner, { service_type_id: types.find((x) => x.code === 'shaving')!.id, name: 'Shaving', price_minor: 10000, duration_min: 20, buffer_min: 10 }).expect(201)).body.data.id;
    const mk = async (name: string) => {
      const r = (await post(`/providers/${providerId}/staff`, owner, { location_id: loc, display_name: name }).expect(201)).body.data;
      return { staffId: r.id as string, resourceId: r.resource_id as string };
    };
    riya = await mk('Riya');
    amit = await mk('Amit');
    await post(`/providers/${providerId}/submit`, owner).expect(200);
    await post(`/admin/providers/${providerId}/approve`, admin).expect(200);
    await put(`/providers/${providerId}/locations/${loc}/hours`, owner, WEEK_9_TO_6).expect(200);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(resetSchedule);

  // ===================================================================================================
  describe('public slot search', () => {
    it('returns advisory slots in UTC with local times, durations and the free stylists', async () => {
      const res = await slotsRes({ date: TUE }).expect(200);
      expect(res.body.meta).toEqual({ advisory: true });
      expect(res.body.data).toMatchObject({ location_id: loc, timezone: 'Asia/Kolkata', service: { id: haircut, name: 'Haircut', duration_min: 30 } });
      const first = res.body.data.slots[0];
      expect(first).toMatchObject({ start_at: '2026-10-13T03:30:00.000Z', end_at: '2026-10-13T04:00:00.000Z', local_start: '2026-10-13T09:00' });
      expect(first.resources.map((r: { display_name: string }) => r.display_name).sort()).toEqual(['Amit', 'Riya']);
      expect(res.body.data.slots).toHaveLength(35); // 09:00..17:30 on a 15-minute grid
    });

    it('needs no authentication, and validates its inputs', async () => {
      await t.http.get('/api/v1/availability/slots').query({ location_id: loc, service_id: haircut }).expect(200);
      await slotsRes({ date: '13/10/2026' }).expect(422);
      await slotsRes({ date: '2026-02-30' }).expect(422);
      await slotsRes({ days: 99 }).expect(422);
      await t.http.get('/api/v1/availability/slots').query({ location_id: 'nope', service_id: haircut }).expect(422);
    });

    it('applies the lead time to "today": at 09:30 IST with a 60-minute lead, the first slot is 10:30', async () => {
      expect((await times({ date: '2026-10-12' }))[0]).toBe('10:30');
    });

    it('never offers the past and honours the maximum advance window (default 30 days)', async () => {
      expect((await times({ date: '2026-10-01' }))[0]).toBe('10:30'); // clamped to today
      expect(await times({ date: '2026-12-15' })).toEqual([]);
    });

    it('spans several days when asked', async () => {
      const res = await slotsRes({ date: TUE, days: 3 }).expect(200);
      const days = new Set((res.body.data.slots as { local_start: string }[]).map((s) => s.local_start.slice(0, 10)));
      expect([...days].sort()).toEqual(['2026-10-13', '2026-10-14', '2026-10-15']);
    });

    it('closed days (Sunday) have no slots', async () => {
      expect(await times({ date: SUN })).toEqual([]);
    });

    it('hides a location and service that are not publicly bookable (uniform 404)', async () => {
      await slotsRes({ location_id: '00000000-0000-4000-8000-00000000dead' }).expect(404);
      await slotsRes({ service_id: '00000000-0000-4000-8000-00000000dead' }).expect(404);
      await t.pool.query("UPDATE provider.providers SET status = 'SUSPENDED' WHERE id = $1", [providerId]);
      await slotsRes({ date: TUE }).expect(404); // suspension removes it from discovery at once
      await t.pool.query("UPDATE provider.providers SET status = 'APPROVED' WHERE id = $1", [providerId]);
      await slotsRes({ date: TUE }).expect(200);
    });

    it('rejects a service that belongs to a different provider', async () => {
      const other = await t.login('9400000010');
      const otherProvider = (await post('/providers', other, { display_name: 'Other Salon' }).expect(201)).body.data.id;
      const types = (await t.http.get('/api/v1/categories/salon/service-types')).body.data as { id: string; code: string }[];
      const foreign = (await post(`/providers/${otherProvider}/services`, other, { service_type_id: types[0]!.id, name: 'X', price_minor: 100, duration_min: 30 }).expect(201)).body.data.id;
      await slotsRes({ service_id: foreign, date: TUE }).expect(404);
    });

    it('treats a service in a disabled category as not offered', async () => {
      const salon = (await get('/admin/categories', admin)).body.data.find((c: { code: string }) => c.code === 'salon');
      await t.http.patch(`/api/v1/admin/categories/${salon.id}`).set(bearer(admin)).send({ is_active: false }).expect(200);
      await slotsRes({ date: TUE }).expect(404);
      await t.http.patch(`/api/v1/admin/categories/${salon.id}`).set(bearer(admin)).send({ is_active: true }).expect(200);
    });
  });

  // ===================================================================================================
  describe('working hours, breaks and staff schedules', () => {
    it('GET returns what PUT stored; PUT replaces the whole pattern', async () => {
      await put(`/providers/${providerId}/locations/${loc}/hours`, owner, {
        working: [{ weekday: 2, start: '10:00', end: '16:00' }],
        breaks: [{ weekday: 2, start: '13:00', end: '14:00' }],
      }).expect(200);
      const got = (await get(`/providers/${providerId}/locations/${loc}/hours`, owner).expect(200)).body.data;
      expect(got).toEqual({ working: [{ weekday: 2, start: '10:00', end: '16:00' }], breaks: [{ weekday: 2, start: '13:00', end: '14:00' }] });
      const starts = await times({ date: TUE });
      expect(starts[0]).toBe('10:00');
      expect(starts).toContain('12:30');
      expect(starts).not.toContain('12:45');
      expect(starts).not.toContain('13:30');
      expect(starts[starts.length - 1]).toBe('15:30');
    });

    it('rejects malformed, inverted and overlapping windows (422), and accepts an end of 24:00', async () => {
      const bad = (working: object[]) => put(`/providers/${providerId}/locations/${loc}/hours`, owner, { working });
      await bad([{ weekday: 8, start: '09:00', end: '18:00' }]).expect(422);
      await bad([{ weekday: 1, start: '9:00', end: '18:00' }]).expect(422);
      await bad([{ weekday: 1, start: '18:00', end: '09:00' }]).expect(422);
      await bad([{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '14:00' }]).expect(422);
      await bad([{ weekday: 1, start: '09:00', end: '24:00' }]).expect(200);
    });

    it('a stylist with her own schedule is bounded by both her hours and the shop hours; others follow the shop', async () => {
      await put(`/providers/${providerId}/staff/${riya.staffId}/schedule`, owner, { working: [{ weekday: 2, start: '12:00', end: '15:00' }] }).expect(200);
      const res = (await slotsRes({ date: TUE }).expect(200)).body.data.slots as { local_start: string; resources: { display_name: string }[] }[];
      const at = (hhmm: string) => res.find((s) => s.local_start.endsWith(hhmm))!.resources.map((r) => r.display_name).sort();
      expect(at('11:00')).toEqual(['Amit']); // Riya starts at 12:00
      expect(at('12:00')).toEqual(['Amit', 'Riya']);
      expect(at('15:00')).toEqual(['Amit']); // Riya finished
      const justRiya = await times({ date: TUE, resource_id: riya.resourceId });
      expect(justRiya[0]).toBe('12:00');
      expect(justRiya[justRiya.length - 1]).toBe('14:30');
    });

    it('filtering by a stylist who does not exist at this location is a 404', async () => {
      await slotsRes({ date: TUE, resource_id: '00000000-0000-4000-8000-00000000dead' }).expect(404);
    });
  });

  // ===================================================================================================
  describe('staff skills (which services each stylist can perform)', () => {
    it('a stylist limited to haircuts is not offered for shaving; a generalist is offered for everything', async () => {
      await put(`/providers/${providerId}/staff/${riya.staffId}/services`, owner, { service_ids: [haircut] }).expect(200);
      const shavingSlots = (await t.http.get('/api/v1/availability/slots').query({ location_id: loc, service_id: shaving, date: TUE }).expect(200)).body.data.slots;
      const names = new Set(shavingSlots.flatMap((s: { resources: { display_name: string }[] }) => s.resources.map((r) => r.display_name)));
      expect([...names]).toEqual(['Amit']);
      const haircutNames = new Set((await slotsRes({ date: TUE }).expect(200)).body.data.slots.flatMap((s: { resources: { display_name: string }[] }) => s.resources.map((r) => r.display_name)));
      expect([...haircutNames].sort()).toEqual(['Amit', 'Riya']);
    });

    it('reads back, supports clearing, and refuses services from another tenant', async () => {
      await put(`/providers/${providerId}/staff/${riya.staffId}/services`, owner, { service_ids: [haircut] }).expect(200);
      expect((await get(`/providers/${providerId}/staff/${riya.staffId}/services`, owner)).body.data).toEqual({ staff_id: riya.staffId, restricted: true, service_ids: [haircut] });
      await put(`/providers/${providerId}/staff/${riya.staffId}/services`, owner, { service_ids: [] }).expect(200);
      expect((await get(`/providers/${providerId}/staff/${riya.staffId}/services`, owner)).body.data.restricted).toBe(false);
      await put(`/providers/${providerId}/staff/${riya.staffId}/services`, owner, { service_ids: ['00000000-0000-4000-8000-00000000dead'] }).expect(422);
      await put(`/providers/${providerId}/staff/${riya.staffId}/services`, stranger, { service_ids: [] }).expect(404);
    });
  });

  // ===================================================================================================
  describe('holidays, leave and special openings', () => {
    it('a location holiday removes the whole day; deleting it brings the slots back', async () => {
      const ex = (await post(`/providers/${providerId}/locations/${loc}/exceptions`, owner, { kind: 'CLOSED', start_date: TUE, reason: 'Diwali' }).expect(201)).body.data;
      expect(await times({ date: TUE })).toEqual([]);
      await del(`/providers/${providerId}/locations/${loc}/exceptions/${ex.id}`, owner).expect(204);
      expect((await times({ date: TUE })).length).toBe(35);
    });

    it('a partial closure removes just that window', async () => {
      await post(`/providers/${providerId}/locations/${loc}/exceptions`, owner, { kind: 'CLOSED', start_date: TUE, start: '11:00', end: '12:00' }).expect(201);
      const starts = await times({ date: TUE });
      expect(starts).toContain('10:30');
      expect(starts).not.toContain('10:45');
      expect(starts).not.toContain('11:30');
      expect(starts).toContain('12:00');
    });

    it("one stylist's leave leaves the other bookable; both on leave = nothing", async () => {
      await post(`/providers/${providerId}/staff/${riya.staffId}/exceptions`, owner, { kind: 'CLOSED', start_date: TUE, end_date: '2026-10-14', reason: 'Leave' }).expect(201);
      const day = (await slotsRes({ date: TUE }).expect(200)).body.data.slots as { resources: { display_name: string }[] }[];
      expect(new Set(day.flatMap((s) => s.resources.map((r) => r.display_name)))).toEqual(new Set(['Amit']));
      await post(`/providers/${providerId}/staff/${amit.staffId}/exceptions`, owner, { kind: 'CLOSED', start_date: TUE }).expect(201);
      expect(await times({ date: TUE })).toEqual([]);
      expect((await times({ date: '2026-10-15' })).length).toBe(35); // leave ended
    });

    it('a special OPEN exception adds hours on a normally closed Sunday', async () => {
      await post(`/providers/${providerId}/locations/${loc}/exceptions`, owner, { kind: 'OPEN', start_date: SUN, start: '10:00', end: '12:00' }).expect(201);
      expect(await times({ date: SUN })).toEqual(['10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30']);
    });

    it('validates exceptions', async () => {
      const bad = (body: object) => post(`/providers/${providerId}/locations/${loc}/exceptions`, owner, body);
      await bad({ kind: 'CLOSED', start_date: 'soon' }).expect(422);
      await bad({ kind: 'CLOSED', start_date: TUE, end_date: '2026-10-01' }).expect(422);
      await bad({ kind: 'CLOSED', start_date: TUE, start: '10:00' }).expect(422); // start without end
      await bad({ kind: 'OPEN', start_date: TUE }).expect(422); // OPEN must say when
      await bad({ kind: 'CLOSED', start_date: TUE, start: '12:00', end: '11:00' }).expect(422);
      await bad({ kind: 'PARTY', start_date: TUE }).expect(422);
    });
  });

  // ===================================================================================================
  describe('time blocks & the database double-booking guard', () => {
    const block = (s: string, a: string, b: string, who = riya) => post(`/providers/${providerId}/staff/${who.staffId}/blocks`, owner, { start_at: a, end_at: b, reason: s });
    // 11:00–12:00 IST on Tuesday = 05:30–06:30Z
    const T = (hhmm: string) => `2026-10-13T${hhmm}:00.000Z`;

    it('a block occupies the stylist: she disappears from overlapping slots while the other stylist remains', async () => {
      await block('Walk-in', T('05:30'), T('06:30')).expect(201);
      const slots = (await slotsRes({ date: TUE }).expect(200)).body.data.slots as { local_start: string; resources: { display_name: string }[] }[];
      const at = (hhmm: string) => slots.find((s) => s.local_start.endsWith(hhmm))?.resources.map((r) => r.display_name).sort();
      expect(at('10:45')).toEqual(['Amit']); // 10:45–11:15 overlaps Riya's block
      expect(at('11:30')).toEqual(['Amit']);
      expect(at('10:30')).toEqual(['Amit', 'Riya']); // ends exactly as the block starts
      expect(at('12:00')).toEqual(['Amit', 'Riya']); // starts exactly as it ends
      await block('Walk-in too', T('05:30'), T('06:30'), amit).expect(201);
      expect(slots).toBeDefined();
      const both = (await slotsRes({ date: TUE }).expect(200)).body.data.slots as { local_start: string }[];
      expect(both.map((s) => s.local_start.slice(11))).not.toContain('11:00');
    });

    it('overlapping blocks on the same stylist are rejected with 409 SLOT_UNAVAILABLE, adjacent ones are fine', async () => {
      await block('first', T('05:30'), T('06:30')).expect(201);
      const clash = await block('overlap', T('06:00'), T('07:00')).expect(409);
      expect(clash.body.code).toBe('SLOT_UNAVAILABLE');
      await block('adjacent before', T('04:30'), T('05:30')).expect(201);
      await block('adjacent after', T('06:30'), T('07:30')).expect(201);
    });

    it('releasing a block frees the time again', async () => {
      const b = (await block('temp', T('05:30'), T('06:30')).expect(201)).body.data;
      await block('retry', T('05:30'), T('06:30')).expect(409);
      await del(`/providers/${providerId}/staff/${riya.staffId}/blocks/${b.id}`, owner).expect(204);
      await block('retry', T('05:30'), T('06:30')).expect(201);
      await del(`/providers/${providerId}/staff/${riya.staffId}/blocks/${b.id}`, owner).expect(404); // already released
    });

    it('under REAL CONCURRENCY exactly one of N identical block requests wins (exclusion constraint)', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => block(`race-${i}`, T('05:30'), T('06:30'))));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(7);
      const rows = await t.pool.query("SELECT count(*)::int AS n FROM scheduling.resource_reservations WHERE resource_id = $1 AND status = 'ACTIVE'", [riya.resourceId]);
      expect(rows.rows[0].n).toBe(1);
    });

    it('partially overlapping concurrent requests also leave no overlap behind', async () => {
      const windows: [string, string][] = [['05:30', '06:30'], ['06:00', '07:00'], ['06:30', '07:30'], ['05:45', '06:45'], ['07:00', '08:00']];
      await Promise.all(windows.map(([a, b], i) => block(`mix-${i}`, T(a), T(b))));
      const overlaps = await t.pool.query(
        `SELECT count(*)::int AS n FROM scheduling.resource_reservations a JOIN scheduling.resource_reservations b
           ON a.resource_id = b.resource_id AND a.id < b.id AND a.status = 'ACTIVE' AND b.status = 'ACTIVE' AND a.occupied && b.occupied`,
      );
      expect(overlaps.rows[0].n).toBe(0);
    });

    it('validates times: whole minutes, ordering, 24h maximum, ISO format', async () => {
      await block('x', '2026-10-13T05:30:30.000Z', T('06:30')).expect(422);
      await block('x', T('06:30'), T('05:30')).expect(422);
      await block('x', T('05:30'), '2026-10-14T06:30:00.000Z').expect(422); // > 24 h
      await block('x', 'tomorrow', T('06:30')).expect(422);
    });

    it('the constraint itself holds even if the application is bypassed (raw SQL)', async () => {
      await block('first', T('05:30'), T('06:30')).expect(201);
      await expect(
        t.pool.query("INSERT INTO scheduling.resource_reservations (id, resource_id, start_at, end_at, kind) VALUES (gen_random_uuid(), $1, $2, $3, 'BOOKING')", [riya.resourceId, T('06:00'), T('07:00')]),
      ).rejects.toThrow(/resource_reservations_no_overlap/);
      await expect(
        t.pool.query("INSERT INTO scheduling.resource_reservations (id, resource_id, start_at, end_at, kind) VALUES (gen_random_uuid(), $1, $2, $3, 'BLOCK')", [riya.resourceId, '2026-10-13T08:00:30Z', T('09:00')]),
      ).rejects.toThrow(/whole_minutes/);
      await expect(
        t.pool.query("INSERT INTO scheduling.availability_rules (id, location_id, rule_type, weekday, start_min, end_min) VALUES (gen_random_uuid(), $1, 'WORKING', 1, 600, 700)", [loc]),
      ).rejects.toThrow(/availability_rules_no_overlap/);
    });

    it('a booking-length block with a buffer removes slots that would collide with the buffer', async () => {
      // 30-minute haircut + a 10-minute buffer reserved as 11:00–11:40 (05:30–06:10Z): the 11:30 slot collides.
      await block('buffered', T('05:30'), T('06:10')).expect(201);
      const s = await t.http.get('/api/v1/availability/slots').query({ location_id: loc, service_id: haircut, date: TUE, resource_id: riya.resourceId });
      const starts = (s.body.data.slots as { local_start: string }[]).map((x) => x.local_start.slice(11));
      expect(starts).not.toContain('11:30');
      expect(starts).toContain('11:45'); // first grid point after 11:40
    });
  });

  // ===================================================================================================
  describe('booking policy (configuration, not code)', () => {
    it('defaults come from the platform row; a provider can override individual fields and clear them again', async () => {
      const base = (await get(`/providers/${providerId}/booking-policy`, owner).expect(200)).body.data.effective;
      expect(base).toEqual({ slot_granularity_min: 15, min_lead_time_min: 60, max_advance_days: 30, response_deadline_min: 30, check_in_window_min: 30, no_show_grace_min: 15, settlement_hold_hours: 24 });

      const changed = (await put(`/providers/${providerId}/booking-policy`, owner, { slot_granularity_min: 30, min_lead_time_min: 0 }).expect(200)).body.data.effective;
      expect(changed).toEqual({ slot_granularity_min: 30, min_lead_time_min: 0, max_advance_days: 30, response_deadline_min: 30, check_in_window_min: 30, no_show_grace_min: 15, settlement_hold_hours: 24 });
      const starts = await times({ date: '2026-10-12' });
      expect(starts[0]).toBe('09:30'); // lead time 0 + 30-minute grid, "now" is 09:30
      expect(starts.every((x) => x.endsWith(':00') || x.endsWith(':30'))).toBe(true);

      const cleared = (await put(`/providers/${providerId}/booking-policy`, owner, {}).expect(200)).body.data.effective;
      expect(cleared).toEqual(base);
    });

    it('rejects invalid values and unauthorised callers', async () => {
      await put(`/providers/${providerId}/booking-policy`, owner, { slot_granularity_min: 7 }).expect(422);
      await put(`/providers/${providerId}/booking-policy`, owner, { max_advance_days: 9999 }).expect(422);
      await put(`/providers/${providerId}/booking-policy`, owner, { sneaky: 1 }).expect(422);
      await put(`/providers/${providerId}/booking-policy`, stranger, {}).expect(404);
    });

    it('the platform row must stay complete (database-enforced)', async () => {
      await expect(t.pool.query("UPDATE scheduling.booking_policies SET max_advance_days = NULL WHERE scope_type = 'PLATFORM'")).rejects.toThrow(/platform_complete/);
    });
  });

  // ===================================================================================================
  describe('time zones', () => {
    it('a New York location is scheduled in its own wall-clock time (EDT = UTC-4 in October)', async () => {
      await put(`/providers/${providerId}/locations/${nycLoc}/hours`, owner, { working: [{ weekday: 2, start: '09:00', end: '17:00' }] }).expect(200);
      const query = { location_id: nycLoc, service_id: haircut, date: TUE };

      // Opening hours alone are not enough: with nobody to perform the service there is nothing to book.
      const empty = await t.http.get('/api/v1/availability/slots').query(query).expect(200);
      expect(empty.body.data.timezone).toBe('America/New_York');
      expect(empty.body.data.slots).toEqual([]);

      await post(`/providers/${providerId}/staff`, owner, { location_id: nycLoc, display_name: 'Nina' }).expect(201);
      const res = await t.http.get('/api/v1/availability/slots').query(query).expect(200);
      expect(res.body.data.slots[0]).toMatchObject({ local_start: '2026-10-13T09:00', start_at: '2026-10-13T13:00:00.000Z' });
      expect(res.body.data.slots).toHaveLength(31); // 09:00..16:30 => 31 starts for a 30-minute service
      expect(res.body.data.slots[0].resources.map((r: { display_name: string }) => r.display_name)).toEqual(['Nina']);
    });
  });

  // ===================================================================================================
  describe('authorization (server-side, IDOR-safe)', () => {
    const cases: [string, () => ReturnType<typeof get>][] = [
      ['read location hours', () => get(`/providers/${providerId}/locations/${loc}/hours`, stranger)],
      ['read staff schedule', () => get(`/providers/${providerId}/staff/${riya.staffId}/schedule`, stranger)],
      ['read staff blocks', () => get(`/providers/${providerId}/staff/${riya.staffId}/blocks`, stranger)],
      ['read exceptions', () => get(`/providers/${providerId}/locations/${loc}/exceptions`, stranger)],
      ['read the policy', () => get(`/providers/${providerId}/booking-policy`, stranger)],
    ];
    it.each(cases)('a stranger cannot %s (404, same as a missing provider)', async (_n, call) => {
      await call().expect(404);
    });

    it('a stranger cannot modify hours, schedules, exceptions or blocks', async () => {
      await put(`/providers/${providerId}/locations/${loc}/hours`, stranger, WEEK_9_TO_6).expect(404);
      await put(`/providers/${providerId}/staff/${riya.staffId}/schedule`, stranger, WEEK_9_TO_6).expect(404);
      await post(`/providers/${providerId}/staff/${riya.staffId}/exceptions`, stranger, { kind: 'CLOSED', start_date: TUE }).expect(404);
      await post(`/providers/${providerId}/staff/${riya.staffId}/blocks`, stranger, { start_at: '2026-10-13T05:30:00.000Z', end_at: '2026-10-13T06:30:00.000Z' }).expect(404);
    });

    it('cross-tenant ids do not work even for a legitimate owner of ANOTHER provider', async () => {
      const other = await t.login('9400000011');
      const otherProvider = (await post('/providers', other, { display_name: 'Other' }).expect(201)).body.data.id;
      // other's own provider id + OUR location / staff ids
      await put(`/providers/${otherProvider}/locations/${loc}/hours`, other, WEEK_9_TO_6).expect(404);
      await post(`/providers/${otherProvider}/staff/${riya.staffId}/blocks`, other, { start_at: '2026-10-13T05:30:00.000Z', end_at: '2026-10-13T06:30:00.000Z' }).expect(404);
      await get(`/providers/${otherProvider}/staff/${riya.staffId}/schedule`, other).expect(404);
    });

    it('a location manager can manage their own location but not a sibling location (location-scoped RBAC)', async () => {
      const manager = await t.login('9400000012');
      const invite = (await post(`/providers/${providerId}/staff`, owner, { location_id: loc, display_name: 'Manager Meera', staff_role: 'MANAGER', phone: '9400000012' }).expect(201)).body.data;
      await post(`/users/me/staff-invitations/${invite.id}/accept`, manager).expect(200);
      await put(`/providers/${providerId}/locations/${loc}/hours`, manager, WEEK_9_TO_6).expect(200);
      await put(`/providers/${providerId}/locations/${nycLoc}/hours`, manager, WEEK_9_TO_6).expect(403); // sibling location
      await post(`/providers/${providerId}/staff/${riya.staffId}/blocks`, manager, { start_at: '2026-10-13T08:30:00.000Z', end_at: '2026-10-13T09:00:00.000Z' }).expect(201);
      await put(`/providers/${providerId}/booking-policy`, manager, {}).expect(403); // owner-only
      // a plain staff member can read but not change schedules
      const stylist = await t.login('9400000013');
      const inv2 = (await post(`/providers/${providerId}/staff`, owner, { location_id: loc, display_name: 'Stylist Sam', staff_role: 'STAFF', phone: '9400000013' }).expect(201)).body.data;
      await post(`/users/me/staff-invitations/${inv2.id}/accept`, stylist).expect(200);
      await get(`/providers/${providerId}/locations/${loc}/hours`, stylist).expect(200);
      await put(`/providers/${providerId}/locations/${loc}/hours`, stylist, WEEK_9_TO_6).expect(403);
    });
  });
});
