import { AdminSession, TestApp, bootTestApp } from './support/app';
import { postgisAvailableSync } from './support/db';

// Spatial behaviour needs REAL PostGIS (see ADR-0004). Without it this suite is reported as SKIPPED.
const describeSpatial = postgisAvailableSync() ? describe : describe.skip;

const NOW = new Date('2026-10-12T05:00:00Z'); // Monday 10:30 IST
const TUE = '2026-10-13';
const ME = { lat: 18.5308, lng: 73.8475 }; // Shivajinagar, Pune

// Real places: Koregaon Park, Kothrud, Hinjewadi (Pune) and Bandra (Mumbai, ~120 km away)
const PLACES = {
  abc: { name: 'ABC Salon', latitude: 18.5362, longitude: 73.8938, city: 'Pune' },
  xyz: { name: 'XYZ Salon', latitude: 18.5074, longitude: 73.8077, city: 'Pune' },
  style: { name: 'Style Studio', latitude: 18.5912, longitude: 73.7389, city: 'Pune' },
  mumbai: { name: 'Bandra Barbers', latitude: 19.0596, longitude: 72.8295, city: 'Mumbai' },
};

/** Independent great-circle distance (haversine) to sanity-check PostGIS's spheroidal answer. */
function haversineM(a: { lat: number; lng: number }, b: { latitude: number; longitude: number }): number {
  const R = 6_371_008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.lat);
  const dLng = rad(b.longitude - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describeSpatial('Discovery: PostGIS search, map and public profile (integration, real PostGIS)', () => {
  let t: TestApp;
  let admin: AdminSession;
  const salons: Record<string, { token: string; providerId: string; locationId: string; staffId: string; resourceId: string; services: Record<string, string> }> = {};

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const search = (q: Record<string, string | number | boolean>) => t.http.get('/api/v1/search/providers').query({ ...ME, ...q });
  const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((r) => r.name);

  async function createSalon(phone: string, key: keyof typeof PLACES, prices: Record<string, number>) {
    const place = PLACES[key];
    const user = await t.login(phone);
    const auth = bearer(user.accessToken);
    const providerId = (await t.http.post('/api/v1/providers').set(auth).send({ display_name: place.name }).expect(201)).body.data.id;
    const locationId = (
      await t.http
        .post(`/api/v1/providers/${providerId}/locations`)
        .set(auth)
        .send({ name: `${place.name} — main`, address_line1: '1 Main Road', city: place.city, state: 'Maharashtra', postal_code: '411001', latitude: place.latitude, longitude: place.longitude })
        .expect(201)
    ).body.data.id;
    const types = (await t.http.get('/api/v1/categories/salon/service-types')).body.data as { id: string; code: string }[];
    const services: Record<string, string> = {};
    for (const [code, price] of Object.entries(prices)) {
      services[code] = (
        await t.http.post(`/api/v1/providers/${providerId}/services`).set(auth).send({ service_type_id: types.find((x) => x.code === code)!.id, name: code, price_minor: price, duration_min: 30 }).expect(201)
      ).body.data.id;
    }
    const staff = (await t.http.post(`/api/v1/providers/${providerId}/staff`).set(auth).send({ location_id: locationId, display_name: `${place.name} stylist` }).expect(201)).body.data;
    await t.http.put(`/api/v1/providers/${providerId}/locations/${locationId}/hours`).set(auth).send({ working: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })) }).expect(200);
    await t.http.post(`/api/v1/providers/${providerId}/submit`).set(auth).expect(200);
    await t.http.post(`/api/v1/admin/providers/${providerId}/approve`).set(bearer(admin.accessToken)).expect(200);
    return { token: user.accessToken, providerId, locationId, staffId: staff.id as string, resourceId: staff.resource_id as string, services };
  }

  beforeAll(async () => {
    t = await bootTestApp();
    t.clock.set(NOW);
    admin = await t.loginAdmin({ phone: '9500000001', email: 'admin@example.com' });
    salons['abc'] = await createSalon('9500000002', 'abc', { haircut: 20000, facial: 30000 });
    salons['xyz'] = await createSalon('9500000003', 'xyz', { haircut: 15000 });
    salons['style'] = await createSalon('9500000004', 'style', { haircut: 25000, facial: 28000 });
    salons['mumbai'] = await createSalon('9500000005', 'mumbai', { haircut: 30000 });
  });
  afterAll(async () => {
    await t.close();
  });

  // =====================================================================================================
  describe('the real PostGIS schema', () => {
    it('uses a geography(Point,4326) column with a GiST index the planner can use', async () => {
      const col = await t.pool.query("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'provider.provider_locations'::regclass AND attname = 'geog'");
      expect(col.rows[0].t).toBe('geography(Point,4326)');
      const client = await t.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off'); // tables are tiny; force the planner to prove the index is usable
        const plan = await client.query("EXPLAIN SELECT 1 FROM provider.provider_locations WHERE ST_DWithin(geog, ST_SetSRID(ST_MakePoint(73.84, 18.53), 4326)::geography, 5000)");
        expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('provider_locations_geog_gix');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  // =====================================================================================================
  describe('nearby search', () => {
    it('returns salons within the radius, nearest first, with distances that agree with an independent calculation', async () => {
      const res = await search({ radius_m: 10_000 }).expect(200);
      expect(names(res)).toEqual(['ABC Salon', 'XYZ Salon']); // Hinjewadi (~13 km) and Mumbai (~120 km) are outside
      for (const r of res.body.data) {
        const truth = haversineM(ME, PLACES[r.name === 'ABC Salon' ? 'abc' : 'xyz']);
        expect(Math.abs(r.distance_m - truth) / truth).toBeLessThan(0.01); // spheroid vs sphere: < 1 %
      }
      expect(res.body.data[0].distance_m).toBeLessThan(res.body.data[1].distance_m);
      expect(res.body.data[0]).toMatchObject({ location_id: salons['abc']!.locationId, address: { city: 'Pune' }, open_now: true, timezone: 'Asia/Kolkata' });
    });

    it('widens with the radius but never reaches a salon 120 km away unless asked', async () => {
      expect(names(await search({ radius_m: 20_000 }).expect(200))).toEqual(['ABC Salon', 'XYZ Salon', 'Style Studio']);
      expect(names(await search({ radius_m: 500 }).expect(200))).toEqual([]);
      expect(names(await search({ radius_m: 50_000 }).expect(200))).not.toContain('Bandra Barbers');
    });

    it('is public (no token) and defaults to 5 km', async () => {
      const res = await t.http.get('/api/v1/search/providers').query(ME).expect(200);
      expect(names(res)).toEqual(['ABC Salon', 'XYZ Salon']);
    });

    it('filters by service type and reports the matching price ("price from")', async () => {
      const facial = await search({ radius_m: 20_000, service_type: 'facial' }).expect(200);
      expect(names(facial)).toEqual(['ABC Salon', 'Style Studio']); // XYZ offers no facial
      expect(facial.body.data[0].price_from).toEqual({ amount_minor: 30000, currency: 'INR' });
      const haircut = await search({ radius_m: 20_000, service_type: 'haircut' }).expect(200);
      expect(Object.fromEntries(haircut.body.data.map((r: { name: string; price_from: { amount_minor: number } }) => [r.name, r.price_from.amount_minor]))).toEqual({
        'ABC Salon': 20000,
        'XYZ Salon': 15000,
        'Style Studio': 25000,
      });
    });

    it('filters by maximum price using only the matching services', async () => {
      expect(names(await search({ radius_m: 20_000, service_type: 'haircut', max_price_minor: 20000 }).expect(200))).toEqual(['ABC Salon', 'XYZ Salon']);
      expect(names(await search({ radius_m: 20_000, service_type: 'haircut', max_price_minor: 10000 }).expect(200))).toEqual([]);
    });

    it('sorts by price (cheapest first) and by next available slot', async () => {
      expect(names(await search({ radius_m: 20_000, service_type: 'haircut', sort: 'price' }).expect(200))).toEqual(['XYZ Salon', 'ABC Salon', 'Style Studio']);
      // Block ABC's only stylist for the whole of today and tomorrow => its next slot is later than the others'
      await t.pool.query(
        `INSERT INTO scheduling.resource_reservations (id, resource_id, start_at, end_at, kind) VALUES (gen_random_uuid(), $1, '2026-10-12T05:00:00Z', '2026-10-13T12:30:00Z', 'BLOCK')`,
        [salons['abc']!.resourceId],
      );
      const byNext = await search({ radius_m: 20_000, service_type: 'haircut', sort: 'next_available' }).expect(200);
      expect(names(byNext)).toEqual(['XYZ Salon', 'Style Studio', 'ABC Salon']);
      const abc = byNext.body.data.find((r: { name: string }) => r.name === 'ABC Salon');
      expect(new Date(abc.next_available_at).getTime()).toBeGreaterThan(new Date('2026-10-13T12:30:00Z').getTime());
      await t.pool.query('DELETE FROM scheduling.resource_reservations');
    });

    it('open_now keeps only salons open at this moment (Monday 10:30 IST)', async () => {
      // XYZ switches to Sunday-only hours, so it is closed on a Monday
      await t.http.put(`/api/v1/providers/${salons['xyz']!.providerId}/locations/${salons['xyz']!.locationId}/hours`).set(bearer(salons['xyz']!.token)).send({ working: [{ weekday: 7, start: '09:00', end: '18:00' }] }).expect(200);
      const all = await search({ radius_m: 10_000 }).expect(200);
      expect(Object.fromEntries(all.body.data.map((r: { name: string; open_now: boolean }) => [r.name, r.open_now]))).toEqual({ 'ABC Salon': true, 'XYZ Salon': false });
      expect(names(await search({ radius_m: 10_000, open_now: true }).expect(200))).toEqual(['ABC Salon']);
      await t.http.put(`/api/v1/providers/${salons['xyz']!.providerId}/locations/${salons['xyz']!.locationId}/hours`).set(bearer(salons['xyz']!.token)).send({ working: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })) }).expect(200);
    });

    it('available_on keeps only salons with a free slot that day', async () => {
      await t.http.post(`/api/v1/providers/${salons['xyz']!.providerId}/locations/${salons['xyz']!.locationId}/exceptions`).set(bearer(salons['xyz']!.token)).send({ kind: 'CLOSED', start_date: TUE, reason: 'Holiday' }).expect(201);
      expect(names(await search({ radius_m: 10_000, service_type: 'haircut', available_on: TUE }).expect(200))).toEqual(['ABC Salon']);
      expect(names(await search({ radius_m: 10_000, service_type: 'haircut', available_on: '2026-10-14' }).expect(200))).toEqual(['ABC Salon', 'XYZ Salon']);
      await t.pool.query('DELETE FROM scheduling.availability_exceptions');
    });

    it('lists the next available slot only when a service is specified', async () => {
      const without = (await search({ radius_m: 10_000 }).expect(200)).body.data[0];
      expect(without).not.toHaveProperty('next_available_at');
      const withService = (await search({ radius_m: 10_000, service_type: 'haircut' }).expect(200)).body.data[0];
      expect(withService.next_available_at).toBe('2026-10-12T06:00:00.000Z'); // 11:30 IST: now + 60 min lead, next grid point... 10:30+60=11:30 IST
    });

    it('never lists providers that are not approved, locations that are inactive/deleted, or disabled categories', async () => {
      await t.pool.query("UPDATE provider.providers SET status = 'SUSPENDED' WHERE id = $1", [salons['abc']!.providerId]);
      expect(names(await search({ radius_m: 10_000 }).expect(200))).toEqual(['XYZ Salon']);
      await t.pool.query("UPDATE provider.providers SET status = 'APPROVED' WHERE id = $1", [salons['abc']!.providerId]);

      await t.pool.query("UPDATE provider.provider_locations SET status = 'INACTIVE' WHERE id = $1", [salons['xyz']!.locationId]);
      expect(names(await search({ radius_m: 10_000 }).expect(200))).toEqual(['ABC Salon']);
      await t.pool.query("UPDATE provider.provider_locations SET status = 'ACTIVE', deleted_at = now() WHERE id = $1", [salons['xyz']!.locationId]);
      expect(names(await search({ radius_m: 10_000 }).expect(200))).toEqual(['ABC Salon']);
      await t.pool.query('UPDATE provider.provider_locations SET deleted_at = NULL WHERE id = $1', [salons['xyz']!.locationId]);

      await t.pool.query("UPDATE catalog.categories SET is_active = false WHERE code = 'salon'");
      expect(names(await search({ radius_m: 10_000 }).expect(200))).toEqual([]);
      await t.pool.query("UPDATE catalog.categories SET is_active = true WHERE code = 'salon'");
      expect(names(await search({ radius_m: 10_000 }).expect(200)).length).toBe(2);
    });

    it('paginates with an opaque cursor, without gaps or duplicates', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await search({ radius_m: 20_000, limit: 1, ...(cursor ? { cursor } : {}) }).expect(200);
        seen.push(...names(res));
        cursor = res.body.meta.next_cursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen).toEqual(['ABC Salon', 'XYZ Salon', 'Style Studio']);
      await search({ cursor: 'not-a-cursor' }).expect(422);
    });

    it('validates input strictly and cannot be used for injection', async () => {
      await t.http.get('/api/v1/search/providers').query({ lat: 91, lng: 73 }).expect(422);
      await t.http.get('/api/v1/search/providers').query({ lat: 18 }).expect(422); // lng missing
      await t.http.get('/api/v1/search/providers').query({ lat: 'abc', lng: 73 }).expect(422);
      await search({ radius_m: 5 }).expect(422);
      await search({ radius_m: 999_999 }).expect(422);
      await search({ limit: 500 }).expect(422);
      await search({ sort: 'distance; DROP TABLE provider.providers' }).expect(422);
      await search({ category: "salon' OR 1=1 --" }).expect(422);
      await search({ available_on: TUE }).expect(422); // needs service_type
      await search({ sort: 'next_available' }).expect(422);
      await search({ unknown_param: 1 }).expect(422);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM provider.providers')).rows[0].n).toBe(4); // still intact
    });
  });

  // =====================================================================================================
  describe('map view', () => {
    const PUNE_BBOX = '73.60,18.40,74.00,18.70';
    const map = (bbox: string, extra: Record<string, string> = {}) => t.http.get('/api/v1/search/map').query({ bbox, ...extra });

    it('returns pins inside the viewport only, with prices', async () => {
      const res = await map(PUNE_BBOX).expect(200);
      expect(res.body.data.map((m: { name: string }) => m.name).sort()).toEqual(['ABC Salon', 'Style Studio', 'XYZ Salon']);
      const abc = res.body.data.find((m: { name: string }) => m.name === 'ABC Salon');
      expect(abc).toMatchObject({ location_id: salons['abc']!.locationId, price_from: { amount_minor: 20000, currency: 'INR' } });
      expect(abc.latitude).toBeCloseTo(18.5362, 4);
      expect(abc.longitude).toBeCloseTo(73.8938, 4);
      const mumbai = await map('72.7,18.9,73.0,19.2').expect(200);
      expect(mumbai.body.data.map((m: { name: string }) => m.name)).toEqual(['Bandra Barbers']);
    });

    it('applies the same category/service filters', async () => {
      const res = await map(PUNE_BBOX, { service_type: 'facial' }).expect(200);
      expect(res.body.data.map((m: { name: string }) => m.name).sort()).toEqual(['ABC Salon', 'Style Studio']);
    });

    it('rejects inverted, oversized and malformed viewports', async () => {
      await map('74.0,18.7,73.6,18.4').expect(422);
      await map('60,0,80,30').expect(422);
      await map('1,2,3').expect(422);
      await map('a,b,c,d').expect(422);
      await map('0,95,10,99').expect(422);
    });
  });

  // =====================================================================================================
  describe('public location profile', () => {
    it('shows everything a customer needs: address, hours, services with prices, staff, rules and directions', async () => {
      const s = salons['abc']!;
      await t.http.put(`/api/v1/providers/${s.providerId}/staff/${s.staffId}/services`).set(bearer(s.token)).send({ service_ids: [s.services['haircut']] }).expect(200);
      const res = await t.http.get(`/api/v1/locations/${s.locationId}`).expect(200); // public: no token
      const p = res.body.data;
      expect(p).toMatchObject({
        name: 'ABC Salon',
        timezone: 'Asia/Kolkata',
        open_now: true,
        address: { city: 'Pune', country: 'IN' },
        rating: { average: null, count: 0 },
        booking_rules: { min_lead_time_min: 60, max_advance_days: 30, slot_granularity_min: 15 },
        cancellation_policy: null,
      });
      expect(p.hours.find((h: { weekday: number }) => h.weekday === 1).windows).toEqual([{ start: '09:00', end: '18:00' }]);
      expect(p.hours.find((h: { weekday: number }) => h.weekday === 7).windows).toEqual([]);
      expect(p.services.map((x: { service_type: string; price: object }) => [x.service_type, x.price])).toEqual([
        ['facial', { amount_minor: 30000, currency: 'INR' }],
        ['haircut', { amount_minor: 20000, currency: 'INR' }],
      ]);
      expect(p.staff).toEqual([{ id: s.resourceId, display_name: 'ABC Salon stylist', service_ids: [s.services['haircut']] }]);
      expect(p.directions.google_maps).toBe('https://www.google.com/maps/dir/?api=1&destination=18.5362,73.8938');
      expect(p.directions.apple_maps).toContain('daddr=18.5362,73.8938');
      expect(JSON.stringify(p)).not.toContain(String(ME.lat)); // the customer's position is never echoed or needed
    });

    it('a stylist with no skill list is reported as able to perform every service (null)', async () => {
      const res = await t.http.get(`/api/v1/locations/${salons['xyz']!.locationId}`).expect(200);
      expect(res.body.data.staff[0].service_ids).toBeNull();
    });

    it('404s for unknown ids and for locations that are not publicly discoverable', async () => {
      await t.http.get('/api/v1/locations/00000000-0000-4000-8000-00000000dead').expect(404);
      await t.http.get('/api/v1/locations/not-a-uuid').expect(400);
      await t.pool.query("UPDATE provider.providers SET status = 'SUSPENDED' WHERE id = $1", [salons['xyz']!.providerId]);
      await t.http.get(`/api/v1/locations/${salons['xyz']!.locationId}`).expect(404);
      await t.pool.query("UPDATE provider.providers SET status = 'APPROVED' WHERE id = $1", [salons['xyz']!.providerId]);
    });
  });
});
