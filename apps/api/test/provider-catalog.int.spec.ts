import { TestApp, bootTestApp } from './support/app';

interface Session {
  userId: string;
  accessToken: string;
}

const LOCATION = {
  name: 'ABC Salon — Koregaon Park',
  address_line1: '12 North Main Road',
  city: 'Pune',
  state: 'Maharashtra',
  postal_code: '411001',
  latitude: 18.5362,
  longitude: 73.8938,
};

describe('Providers, catalogue, RBAC & IDOR (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let admin: Session;
  let ownerA: Session;
  let ownerB: Session;
  let stranger: Session;

  const bearer = (s: Session) => ({ Authorization: `Bearer ${s.accessToken}` });
  const get = (path: string, s: Session) => t.http.get(`/api/v1${path}`).set(bearer(s));
  const post = (path: string, s: Session, body: object = {}) => t.http.post(`/api/v1${path}`).set(bearer(s)).send(body);
  const patch = (path: string, s: Session, body: object) => t.http.patch(`/api/v1${path}`).set(bearer(s)).send(body);
  const del = (path: string, s: Session) => t.http.delete(`/api/v1${path}`).set(bearer(s));

  async function registerProvider(s: Session, name = 'ABC Salon'): Promise<string> {
    const res = await post('/providers', s, { display_name: name }).expect(201);
    return res.body.data.id;
  }
  async function addLocation(s: Session, providerId: string): Promise<string> {
    const res = await post(`/providers/${providerId}/locations`, s, LOCATION).expect(201);
    return res.body.data.id;
  }
  async function haircutTypeId(s: Session): Promise<string> {
    const res = await get('/categories/salon/service-types', s).expect(200);
    return res.body.data.find((x: { code: string }) => x.code === 'haircut').id;
  }

  beforeAll(async () => {
    t = await bootTestApp();
    // Privileged accounts sign in through the real password + TOTP flow (no shortcuts).
    admin = await t.loginAdmin({ phone: '9100000001', email: 'admin@example.com' });
    ownerA = await t.login('9100000002');
    ownerB = await t.login('9100000003');
    stranger = await t.login('9100000004');
  });
  afterAll(async () => {
    await t.close();
  });

  // ---------------------------------------------------------------------------------------------------
  describe('category catalogue (configurable verticals, requirements §5/§7)', () => {
    it('is public and shows only enabled categories — initially just Salon', async () => {
      const res = await t.http.get('/api/v1/categories').expect(200);
      expect(res.body.data.map((c: { code: string }) => c.code)).toEqual(['salon']);
      expect(res.body.data[0]).not.toHaveProperty('is_active'); // admin-only detail stays hidden
    });

    it('lists the seeded salon service types and hides disabled categories entirely', async () => {
      const ok = await t.http.get('/api/v1/categories/salon/service-types').expect(200);
      expect(ok.body.data.map((s: { code: string }) => s.code)).toEqual([
        'haircut', 'shaving', 'hair_coloring', 'facial', 'head_massage', 'hair_spa', 'beard_trim', 'manicure', 'pedicure', 'waxing',
      ]);
      await t.http.get('/api/v1/categories/spa/service-types').expect(404);
      await t.http.get('/api/v1/categories/does_not_exist/service-types').expect(404);
    });

    it('ships kinds of service for the other verticals too (car wash, tyre change, ...), invisible to the public until the category is enabled', async () => {
      const categories = (await get('/admin/categories', admin).expect(200)).body.data as { id: string; code: string }[];
      const vehicle = categories.find((c) => c.code === 'vehicle_service')!;
      const kinds = (await get(`/admin/categories/${vehicle.id}/service-types`, admin).expect(200)).body.data as { code: string }[];
      expect(kinds.map((k) => k.code)).toEqual(expect.arrayContaining(['car_wash', 'painting_denting', 'air_check', 'tyre_change']));
      // every vertical has something to pick, so enabling it from the admin portal is all that is needed to offer it
      for (const code of ['spa', 'doctor', 'clinic', 'pathology_lab', 'home_services', 'restaurant']) {
        const c = categories.find((x) => x.code === code)!;
        expect((await get(`/admin/categories/${c.id}/service-types`, admin).expect(200)).body.data.length).toBeGreaterThan(0);
      }
      await t.http.get('/api/v1/categories/vehicle_service/service-types').expect(404); // still disabled: the public cannot see it
    });

    it('only platform administrators may manage categories (server-side RBAC)', async () => {
      await t.http.get('/api/v1/admin/categories').expect(401);
      await get('/admin/categories', ownerA).expect(403);
      await post('/admin/categories', ownerA, { code: 'x_cat', name: 'X' }).expect(403);
      const ok = await get('/admin/categories', admin).expect(200);
      expect(ok.body.data.length).toBeGreaterThanOrEqual(8);
    });

    it('lets an admin create a vertical (disabled), enable it, and audits before/after', async () => {
      const created = await post('/admin/categories', admin, { code: 'tattoo_studio', name: 'Tattoo studio' }).expect(201);
      expect(created.body.data.is_active).toBe(false);
      const id = created.body.data.id;
      expect((await t.http.get('/api/v1/categories')).body.data.map((c: { code: string }) => c.code)).not.toContain('tattoo_studio');

      const enabled = await patch(`/admin/categories/${id}`, admin, { is_active: true, expected_version: 1 }).expect(200);
      expect(enabled.body.data).toMatchObject({ is_active: true, version: 2 });
      expect((await t.http.get('/api/v1/categories')).body.data.map((c: { code: string }) => c.code)).toContain('tattoo_studio');

      const audit = await t.pool.query(
        "SELECT action, before_data, after_data FROM audit.audit_logs WHERE entity_id = $1 ORDER BY occurred_at",
        [id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['catalog.category_created', 'catalog.category_enabled']);
      expect(audit.rows[1].before_data.is_active).toBe(false);
      expect(audit.rows[1].after_data.is_active).toBe(true);
    });

    it('rejects duplicate codes, stale versions, and attempts to change the immutable booking flow type', async () => {
      await post('/admin/categories', admin, { code: 'salon', name: 'Dup' }).expect(409);
      const spa = (await get('/admin/categories', admin)).body.data.find((c: { code: string }) => c.code === 'spa');
      const stale = await patch(`/admin/categories/${spa.id}`, admin, { name: 'Spa & wellness', expected_version: 99 }).expect(409);
      expect(stale.body.code).toBe('CONCURRENT_MODIFICATION');
      await patch(`/admin/categories/${spa.id}`, admin, { booking_flow_type: 'TABLE_RESERVATION' }).expect(422);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('provider registration & verification lifecycle', () => {
    let providerId: string;

    it('requires authentication and rejects attempts to set server-owned fields', async () => {
      await t.http.post('/api/v1/providers').send({ display_name: 'Nope' }).expect(401);
      const res = await post('/providers', ownerA, { display_name: 'Sneaky', status: 'APPROVED' }).expect(422);
      expect(res.body.errors.fields.status).toBeDefined();
    });

    it('registers a provider in DRAFT and makes the registrant its owner', async () => {
      providerId = await registerProvider(ownerA, 'ABC Salon');
      const mine = await get('/providers/mine', ownerA).expect(200);
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0]).toMatchObject({ id: providerId, status: 'DRAFT' });
      const me = await get('/users/me', ownerA).expect(200);
      expect(me.body.data.permissions).toEqual(expect.arrayContaining(['location:manage', 'service:manage', 'staff:manage']));
    });

    it('cannot be submitted without a location, and status is only changed through commands', async () => {
      const res = await post(`/providers/${providerId}/submit`, ownerA).expect(409);
      expect(res.body.code).toBe('PROVIDER_INCOMPLETE');
      await patch(`/providers/${providerId}`, ownerA, { status: 'APPROVED' }).expect(422);
    });

    it('is invisible to other users (IDOR): 404 identical to a non-existent id', async () => {
      const real = await get(`/providers/${providerId}`, stranger).expect(404);
      const fake = await get('/providers/00000000-0000-4000-8000-00000000dead', stranger).expect(404);
      expect(real.body.code).toBe(fake.body.code);
      await patch(`/providers/${providerId}`, stranger, { display_name: 'Hijacked' }).expect(404);
      await post(`/providers/${providerId}/locations`, stranger, LOCATION).expect(404);
      await post(`/providers/${providerId}/staff`, stranger, { location_id: '00000000-0000-4000-8000-000000000001', display_name: 'X' }).expect(404);
      await get(`/providers/${providerId}/services`, stranger).expect(404);
    });

    it('goes DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED with audit trail; owner cannot self-approve', async () => {
      await addLocation(ownerA, providerId);
      const submitted = await post(`/providers/${providerId}/submit`, ownerA).expect(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');
      await post(`/providers/${providerId}/submit`, ownerA).expect(409); // already submitted

      await post(`/admin/providers/${providerId}/approve`, ownerA).expect(403); // owner has no platform permission
      await post(`/admin/providers/${providerId}/approve`, stranger).expect(403);

      const queue = await get('/admin/providers?status=SUBMITTED', admin).expect(200);
      expect(queue.body.data.map((p: { id: string }) => p.id)).toContain(providerId);

      await post(`/admin/providers/${providerId}/start-review`, admin).expect(200);
      const approved = await post(`/admin/providers/${providerId}/approve`, admin).expect(200);
      expect(approved.body.data.status).toBe('APPROVED');
      await post(`/admin/providers/${providerId}/approve`, admin).expect(409); // not re-approvable

      const audit = await t.pool.query("SELECT action, before_data, after_data FROM audit.audit_logs WHERE entity_id = $1 AND entity_type = 'provider' ORDER BY occurred_at", [providerId]);
      expect(audit.rows.map((r) => r.action)).toEqual([
        'provider.registered',
        'provider.submit',
        'provider.start_review',
        'provider.approve',
      ]);
      expect(audit.rows[3].before_data.status).toBe('UNDER_REVIEW');
      expect(audit.rows[3].after_data.status).toBe('APPROVED');
    });

    it('rejection needs a reason, shows it to the owner, and allows a corrected resubmission', async () => {
      const id = await registerProvider(ownerB, 'XYZ Salon');
      await addLocation(ownerB, id);
      await post(`/providers/${id}/submit`, ownerB).expect(200);

      await post(`/admin/providers/${id}/reject`, admin, {}).expect(422);
      await post(`/admin/providers/${id}/reject`, admin, { reason: 'PAN document is unreadable' }).expect(200);
      const seen = await get(`/providers/${id}`, ownerB).expect(200);
      expect(seen.body.data).toMatchObject({ status: 'REJECTED', decision_reason: 'PAN document is unreadable' });

      const again = await post(`/providers/${id}/submit`, ownerB).expect(200);
      expect(again.body.data.status).toBe('SUBMITTED');
    });

    it('a suspended provider cannot edit itself or its catalogue; reinstatement restores it', async () => {
      await post(`/admin/providers/${providerId}/suspend`, admin, { reason: 'Fraud investigation #12' }).expect(200);
      expect((await patch(`/providers/${providerId}`, ownerA, { display_name: 'New name' }).expect(409)).body.code).toBe('PROVIDER_SUSPENDED');
      const typeId = await haircutTypeId(ownerA);
      await post(`/providers/${providerId}/services`, ownerA, { service_type_id: typeId, name: 'Haircut', price_minor: 20000, duration_min: 30 }).expect(409);
      await post(`/admin/providers/${providerId}/reinstate`, admin).expect(200);
      await patch(`/providers/${providerId}`, ownerA, { display_name: 'ABC Salon & Spa' }).expect(200);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('locations', () => {
    let providerId: string;

    beforeAll(async () => {
      providerId = (await get('/providers/mine', ownerA)).body.data[0].id;
    });

    it('stores and returns coordinates with validated ranges and timezone', async () => {
      const loc = (await get(`/providers/${providerId}/locations`, ownerA).expect(200)).body.data[0];
      expect(loc).toMatchObject({ city: 'Pune', timezone: 'Asia/Kolkata', country: 'IN', status: 'ACTIVE' });
      expect(loc.latitude).toBeCloseTo(18.5362, 4);
      expect(loc.longitude).toBeCloseTo(73.8938, 4);

      await post(`/providers/${providerId}/locations`, ownerA, { ...LOCATION, latitude: 91 }).expect(422);
      await post(`/providers/${providerId}/locations`, ownerA, { ...LOCATION, longitude: -181 }).expect(422);
      const tz = await post(`/providers/${providerId}/locations`, ownerA, { ...LOCATION, timezone: 'Mars/Olympus' }).expect(422);
      expect(tz.body.errors.fields.timezone).toBeDefined();
    });

    it('updates and soft-deletes; other owners cannot touch it', async () => {
      const locId = (await get(`/providers/${providerId}/locations`, ownerA)).body.data[0].id;
      await patch(`/providers/${providerId}/locations/${locId}`, ownerB, { name: 'Hijack' }).expect(404);
      const upd = await patch(`/providers/${providerId}/locations/${locId}`, ownerA, { name: 'Renamed', latitude: 18.5, longitude: 73.9 }).expect(200);
      expect(upd.body.data.name).toBe('Renamed');
      await patch(`/providers/${providerId}/locations/${locId}`, ownerA, { latitude: 18.5 }).expect(422); // must come as a pair
      await del(`/providers/${providerId}/locations/${locId}`, ownerA).expect(204);
      expect((await get(`/providers/${providerId}/locations`, ownerA)).body.data).toHaveLength(0);
      await addLocation(ownerA, providerId); // restore one for later suites
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('provider service catalogue — the only trusted source of price/duration (requirements §9)', () => {
    let providerId: string;
    let haircut: string;

    beforeAll(async () => {
      providerId = (await get('/providers/mine', ownerA)).body.data[0].id;
      haircut = await haircutTypeId(ownerA);
    });

    it('creates a ₹200 / 30 min haircut; money crosses the API as integer minor units', async () => {
      const res = await post(`/providers/${providerId}/services`, ownerA, {
        service_type_id: haircut,
        name: 'Haircut',
        price_minor: 20000,
        duration_min: 30,
        buffer_min: 5,
      }).expect(201);
      expect(res.body.data).toMatchObject({ price: { amount_minor: 20000, currency: 'INR' }, duration_min: 30, buffer_min: 5, version: 1, is_active: true });
      const row = await t.pool.query('SELECT price_minor FROM catalog.provider_services WHERE id = $1', [res.body.data.id]);
      expect(row.rows[0].price_minor).toBe('20000'); // bigint, never a float
    });

    it('rejects floats, negatives, absurd prices and unknown fields', async () => {
      const base = { service_type_id: haircut, name: 'Bad', duration_min: 30 };
      await post(`/providers/${providerId}/services`, ownerA, { ...base, price_minor: 199.99 }).expect(422);
      await post(`/providers/${providerId}/services`, ownerA, { ...base, price_minor: -1 }).expect(422);
      await post(`/providers/${providerId}/services`, ownerA, { ...base, price_minor: 100_000_001 }).expect(422);
      await post(`/providers/${providerId}/services`, ownerA, { ...base, price_minor: 100, commission_bps: 0 }).expect(422);
      await post(`/providers/${providerId}/services`, ownerA, { ...base, price_minor: 100, duration_min: 2 }).expect(422);
    });

    it('bumps the version only when price/duration/buffer change (booking snapshots depend on it)', async () => {
      const id = (await get(`/providers/${providerId}/services`, ownerA)).body.data[0].id;
      expect((await patch(`/providers/${providerId}/services/${id}`, ownerA, { name: 'Classic haircut' }).expect(200)).body.data.version).toBe(1);
      const priced = await patch(`/providers/${providerId}/services/${id}`, ownerA, { price_minor: 25000 }).expect(200);
      expect(priced.body.data).toMatchObject({ version: 2, price: { amount_minor: 25000, currency: 'INR' } });
      expect((await patch(`/providers/${providerId}/services/${id}`, ownerA, { price_minor: 25000 }).expect(200)).body.data.version).toBe(2); // unchanged price
      expect((await patch(`/providers/${providerId}/services/${id}`, ownerA, { duration_min: 45 }).expect(200)).body.data.version).toBe(3);
    });

    it('refuses service types of disabled categories', async () => {
      const spa = (await get('/admin/categories', admin)).body.data.find((c: { code: string }) => c.code === 'spa');
      const type = await post(`/admin/categories/${spa.id}/service-types`, admin, { code: 'hot_stone', name: 'Hot stone massage' }).expect(201);
      await post('/admin/categories/' + spa.id + '/service-types', admin, { code: 'hot_stone', name: 'Dup' }).expect(409);
      const res = await post(`/providers/${providerId}/services`, ownerA, { service_type_id: type.body.data.id, name: 'Massage', price_minor: 50000, duration_min: 60 }).expect(409);
      expect(res.body.code).toBe('CATEGORY_NOT_ENABLED');
    });

    it('isolates tenants: another owner can neither read nor modify these services', async () => {
      const id = (await get(`/providers/${providerId}/services`, ownerA)).body.data[0].id;
      await get(`/providers/${providerId}/services`, ownerB).expect(404);
      await patch(`/providers/${providerId}/services/${id}`, ownerB, { price_minor: 1 }).expect(404);
      await del(`/providers/${providerId}/services/${id}`, ownerB).expect(404);
      // ownerB's OWN provider id + ownerA's service id must not cross tenants either
      const providerB = (await get('/providers/mine', ownerB)).body.data[0].id;
      await patch(`/providers/${providerB}/services/${id}`, ownerB, { price_minor: 1 }).expect(404);
    });

    it('soft-deletes a service', async () => {
      const created = await post(`/providers/${providerId}/services`, ownerA, { service_type_id: haircut, name: 'Temp', price_minor: 100, duration_min: 15 }).expect(201);
      await del(`/providers/${providerId}/services/${created.body.data.id}`, ownerA).expect(204);
      const left = (await get(`/providers/${providerId}/services`, ownerA)).body.data.map((s: { id: string }) => s.id);
      expect(left).not.toContain(created.body.data.id);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('staff, invitations and location-scoped access', () => {
    let providerId: string;
    let loc1: string;
    let loc2: string;
    let stylist: Session;
    let staffId: string;

    beforeAll(async () => {
      providerId = (await get('/providers/mine', ownerA)).body.data[0].id;
      loc1 = (await get(`/providers/${providerId}/locations`, ownerA)).body.data[0].id;
      loc2 = await addLocation(ownerA, providerId);
      stylist = await t.login('9100000005');
    });

    it('inviting by phone creates NO account and exposes no phone number', async () => {
      const usersBefore = (await t.pool.query('SELECT count(*)::int AS n FROM identity.users')).rows[0].n;
      const res = await post(`/providers/${providerId}/staff`, ownerA, {
        location_id: loc1,
        display_name: 'Riya (stylist)',
        staff_role: 'STAFF',
        phone: '9100000005',
      }).expect(201);
      staffId = res.body.data.id;
      expect(res.body.data).toMatchObject({ status: 'INVITED', has_login: false });
      expect(JSON.stringify(res.body)).not.toContain('9100000005');
      expect((await t.pool.query('SELECT count(*)::int AS n FROM identity.users')).rows[0].n).toBe(usersBefore);
      const resource = await t.pool.query("SELECT kind, location_id FROM provider.bookable_resources WHERE id = $1", [res.body.data.resource_id]);
      expect(resource.rows[0]).toMatchObject({ kind: 'STAFF', location_id: loc1 });
    });

    it('before accepting, the invitee has no access; only the addressed user sees/accepts the invitation', async () => {
      await get(`/providers/${providerId}/staff?location_id=${loc1}`, stylist).expect(404);
      const mine = await get('/users/me/staff-invitations', stylist).expect(200);
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0]).toMatchObject({ provider_name: expect.any(String), staff_role: 'STAFF' });
      expect((await get('/users/me/staff-invitations', stranger)).body.data).toHaveLength(0);
      await post(`/users/me/staff-invitations/${staffId}/accept`, stranger).expect(404); // not theirs
    });

    it('accepting grants ONLY location-scoped access to that location', async () => {
      await post(`/users/me/staff-invitations/${staffId}/accept`, stylist).expect(200);
      expect((await get('/users/me/staff-invitations', stylist)).body.data).toHaveLength(0);

      await get(`/providers/${providerId}/staff?location_id=${loc1}`, stylist).expect(200); // their location
      await get(`/providers/${providerId}/staff?location_id=${loc2}`, stylist).expect(403); // sibling location
      await get(`/providers/${providerId}/staff`, stylist).expect(403); // provider-wide
      await get(`/providers/${providerId}/services`, stylist).expect(200); // may read the catalogue
      await post(`/providers/${providerId}/services`, stylist, { service_type_id: await haircutTypeId(stylist), name: 'x', price_minor: 1, duration_min: 15 }).expect(403);
      await post(`/providers/${providerId}/staff`, stylist, { location_id: loc1, display_name: 'Pal' }).expect(403);
      await post(`/providers/${providerId}/locations`, stylist, LOCATION).expect(403);
      await post(`/providers/${providerId}/submit`, stylist).expect(403);
      const audit = await t.pool.query("SELECT 1 FROM audit.audit_logs WHERE action = 'provider.staff_invitation_accepted'");
      expect(audit.rowCount).toBe(1);
    });

    it('promoting to MANAGER swaps the real grant, not just the label', async () => {
      await patch(`/providers/${providerId}/staff/${staffId}`, ownerA, { staff_role: 'MANAGER' }).expect(200);
      const roles = await t.pool.query(
        `SELECT r.code FROM identity.role_assignments ra JOIN identity.roles r ON r.id = ra.role_id
         WHERE ra.user_id = $1 AND ra.revoked_at IS NULL AND ra.scope_type = 'LOCATION' ORDER BY r.code`,
        [stylist.userId],
      );
      expect(roles.rows.map((r) => r.code)).toEqual(['PROVIDER_MANAGER']);
    });

    it('removing staff revokes their access immediately', async () => {
      await del(`/providers/${providerId}/staff/${staffId}`, ownerA).expect(204);
      await get(`/providers/${providerId}/staff?location_id=${loc1}`, stylist).expect(404);
      const active = await t.pool.query("SELECT count(*)::int AS n FROM identity.role_assignments WHERE user_id = $1 AND scope_type = 'LOCATION' AND revoked_at IS NULL", [stylist.userId]);
      expect(active.rows[0].n).toBe(0);
    });

    it('declining an invitation discards it and the stored phone hash', async () => {
      const res = await post(`/providers/${providerId}/staff`, ownerA, { location_id: loc2, display_name: 'Temp', phone: '9100000005' }).expect(201);
      await post(`/users/me/staff-invitations/${res.body.data.id}/decline`, stylist).expect(204);
      expect((await get('/users/me/staff-invitations', stylist)).body.data).toHaveLength(0);
      const row = await t.pool.query('SELECT invited_phone_hash, deleted_at FROM provider.provider_staff WHERE id = $1', [res.body.data.id]);
      expect(row.rows[0].invited_phone_hash).toBeNull();
      expect(row.rows[0].deleted_at).not.toBeNull();
    });

    it('staff without a login (owner-managed calendars) are valid and cannot cross locations/providers', async () => {
      const res = await post(`/providers/${providerId}/staff`, ownerA, { location_id: loc1, display_name: 'Walk-in chair 1' }).expect(201);
      expect(res.body.data).toMatchObject({ status: 'ACTIVE', has_login: false });
      // a location from a DIFFERENT provider is rejected, even for a valid owner
      const providerB = (await get('/providers/mine', ownerB)).body.data[0].id;
      const otherLoc = await addLocation(ownerB, providerB);
      await post(`/providers/${providerId}/staff`, ownerA, { location_id: otherLoc, display_name: 'Cross-tenant' }).expect(404);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe('platform roles', () => {
    it('separates duties: support can read providers but cannot approve; finance cannot manage categories', async () => {
      const support = await t.loginAdmin({ phone: '9100000006', email: 'support@example.com', roles: ['SUPPORT_OPERATOR'] });
      const finance = await t.loginAdmin({ phone: '9100000007', email: 'finance@example.com', roles: ['FINANCE_OPERATOR'] });

      await get('/admin/providers', support).expect(200);
      const id = (await get('/providers/mine', ownerB)).body.data[0].id;
      await post(`/admin/providers/${id}/approve`, support).expect(403);
      await get('/admin/categories', finance).expect(403);
      await get('/admin/providers', finance).expect(200);
    });

    it('rejects role assignment whose scope does not match the role (database-enforced)', async () => {
      await expect(
        t.pool.query(
          `INSERT INTO identity.role_assignments (id, user_id, role_id, scope_type, scope_id)
           SELECT gen_random_uuid(), $1, r.id, 'PLATFORM', NULL FROM identity.roles r WHERE r.code = 'PROVIDER_OWNER'`,
          [stranger.userId],
        ),
      ).rejects.toThrow(/role_assignments_role_scope_fk/);
    });
  });
});
