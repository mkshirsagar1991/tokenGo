import { AdminSession, TestApp, bootTestApp } from './support/app';
import { BookingWorld, NOW, Salon, User, bookingWorld, ist } from './support/booking-world';

describe('Reviews: eligibility, one per booking, public listing and search rating, replies, moderation (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let w: BookingWorld;
  let admin: AdminSession;
  let support: AdminSession;
  let salon: Salon;
  const bearer = (a: { accessToken: string }) => ({ Authorization: `Bearer ${a.accessToken}` });
  /** The customer behind each booking, so a test can act as the author of a review it only has the id of. */
  const customers = new Map<string, User>();
  const customerOf = async (bookingId: string): Promise<User> => customers.get((await t.pool.query('SELECT customer_id FROM booking.bookings WHERE id = $1', [bookingId])).rows[0].customer_id)!;

  /** A different time for every booking: the salon has two stylists, so reusing a slot would make later bookings fail. */
  let slotSeq = 0;
  const nextSlot = () => {
    const i = slotSeq++;
    const minutes = 9 * 60 + (i % 6) * 90; // 09:00, 10:30, 12:00, 13:30, 15:00, 16:30
    return { day: 13 + Math.floor(i / 6), hhmm: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
  };

  /** A booking taken all the way to CLOSED (settled), so it can be reviewed. */
  async function settled(_day?: number, _hhmm?: string, who?: User) {
    const { day, hhmm } = nextSlot();
    const customer = who ?? (await w.customer(1000));
    customers.set(customer.userId, customer);
    const b = await w.bookOk(customer, salon, ist(day, hhmm));
    expect((await w.act('approve', b.id, salon.owner)).status).toBe(200);
    await w.runToCompleted(b, customer, salon, new Date(ist(day, hhmm)));
    expect((await w.act('confirm-completion', b.id, customer)).status).toBe(200);
    return { customer, booking: b };
  }
  const publicList = (query = '') => t.http.get(`/api/v1/locations/${salon.locationId}/reviews${query}`);
  const searchRating = async () => {
    const res = await t.http.get('/api/v1/search/providers?lat=18.53&lng=73.85&radius_m=5000').expect(200);
    return res.body.data.find((r: { location_id: string }) => r.location_id === salon.locationId).rating as { average: number | null; count: number };
  };
  const adminToken = async () => bearer(await t.reloginAdmin(admin));

  beforeAll(async () => {
    t = await bootTestApp();
    t.clock.set(NOW);
    admin = await t.loginAdmin({ phone: '9500099999', email: 'admin@example.com' });
    support = await t.loginAdmin({ phone: '9500099998', email: 'support@example.com', roles: ['SUPPORT_OPERATOR'] });
    w = bookingWorld(t, () => admin, '95');
    salon = await w.createSalon('Review Salon');
  });
  afterAll(() => t?.close());

  describe('who may review, and when', () => {
    it('only after the booking is completed AND settled, only by its own customer', async () => {
      const c = await w.customer(1000);
      const { day, hhmm } = nextSlot();
      const b = await w.bookOk(c, salon, ist(day, hhmm));
      const early = await w.post(`/appointments/${b.id}/review`, c, { rating: 5 });
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('REVIEW_NOT_ALLOWED');

      const stranger = await w.customer(0);
      expect((await w.post(`/appointments/${b.id}/review`, stranger, { rating: 5 })).status).toBe(404); // not yours = does not exist
      await t.http.post(`/api/v1/appointments/${b.id}/review`).send({ rating: 5 }).expect(401);
      expect((await w.post(`/appointments/${b.id}/review`, salon.owner, { rating: 5 })).status).toBe(404); // the salon cannot review itself
    });

    it('is switched off by the feature flag and back on, nothing else changes', async () => {
      const { customer, booking } = await settled(13, '10:30');
      let h = await adminToken();
      await t.http.put('/api/v1/admin/settings/features.reviews_enabled').set(h).send({ value: false }).expect(200);
      const off = await w.post(`/appointments/${booking.id}/review`, customer, { rating: 5 });
      expect(off.status).toBe(409);
      expect(off.body.code).toBe('REVIEWS_DISABLED');
      h = await adminToken();
      await t.http.put('/api/v1/admin/settings/features.reviews_enabled').set(h).send({ value: true }).expect(200);
      expect((await w.post(`/appointments/${booking.id}/review`, customer, { rating: 5 })).status).toBe(201);
    });
  });

  describe('writing a review', () => {
    it('one review per booking; the author can read and edit it; edits move the rating', async () => {
      const { customer, booking } = await settled(13, '11:00');
      const created = await w.post(`/appointments/${booking.id}/review`, customer, { rating: 5, comment: '  Lovely haircut!  ' });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ rating: 5, comment: 'Lovely haircut!', status: 'PUBLISHED', booking_id: booking.id, service_name: 'haircut' });

      const again = await w.post(`/appointments/${booking.id}/review`, customer, { rating: 1 });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_REVIEWED');

      const before = await searchRating();
      const edited = await w.put(`/appointments/${booking.id}/review`, customer, { rating: 3, comment: 'Good, but a long wait.' });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ rating: 3, comment: 'Good, but a long wait.' });
      const after = await searchRating();
      expect(after.count).toBe(before.count);
      expect(after.average).toBeLessThan(before.average!);

      expect((await w.get(`/appointments/${booking.id}/review`, customer)).body.data.rating).toBe(3);
      const stranger = await w.customer(0);
      expect((await w.get(`/appointments/${booking.id}/review`, stranger)).body.data).toBeNull();
    });

    it.each([
      [{ rating: 0 }, /1 to 5/],
      [{ rating: 6 }, /1 to 5/],
      [{ rating: 2.5 }, /whole number/],
      [{ rating: '5' }, /whole number/],
      [{ rating: 5, comment: 'x'.repeat(1001) }, /at most 1000/],
      [{ rating: 5, comment: 'bad\u0007bell' }, /not allowed/],
      [{ rating: 5, comment: 42 }, /must be text/],
    ])('refuses %j with a clear message', async (body, message) => {
      const { customer, booking } = await settled(14, '09:00');
      const res = await w.post(`/appointments/${booking.id}/review`, customer, body);
      expect(res.status).toBe(422);
      expect(res.body.detail).toMatch(message);
    });

    it('stores text as typed (never interpreted), keeps line breaks, collapses blank runs, and treats empty text as none', async () => {
      const { customer, booking } = await settled(14, '09:30');
      const res = await w.post(`/appointments/${booking.id}/review`, customer, { rating: 4, comment: '<script>alert(1)</script>\r\nline two\n\n\n\nline three' });
      expect(res.body.data.comment).toBe('<script>alert(1)</script>\nline two\n\nline three');
      const blank = await settled(14, '10:00');
      expect((await w.post(`/appointments/${blank.booking.id}/review`, blank.customer, { rating: 5, comment: '   ' })).body.data.comment).toBeNull();
    });

    it('can only be written within the review window', async () => {
      const { customer, booking } = await settled(15, '09:00');
      t.clock.advanceSeconds(31 * 86_400);
      const late = await w.post(`/appointments/${booking.id}/review`, customer, { rating: 5 });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('REVIEW_WINDOW_PASSED');
      // Never move the clock BACKWARDS: events published "in the future" would stop being due. Continue from just after the busy days.
      t.clock.set(new Date(ist(20, '09:00')));
    });
  });

  describe('what everyone sees', () => {
    it('lists published reviews newest first with NO customer identity, plus the rating summary; discovery shows the same rating', async () => {
      const res = await publicList().expect(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(['comment', 'created_at', 'id', 'rating', 'reply', 'service_name']);
      expect(JSON.stringify(res.body)).not.toMatch(/customer|user_id|phone/i);
      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect([...ids].sort().reverse()).toEqual(ids);

      const { summary } = res.body.meta;
      expect(summary.count).toBe(res.body.data.length);
      const fromList = res.body.data.reduce((a: number, r: { rating: number }) => a + r.rating, 0) / res.body.data.length;
      expect(summary.average).toBeCloseTo(fromList, 1);
      expect(Object.values(summary.distribution).reduce((a: number, n) => a + (n as number), 0)).toBe(summary.count);

      const rating = await searchRating();
      expect(rating.count).toBe(summary.count);
      expect(rating.average).toBeCloseTo(summary.average, 1);
    });

    it('paginates, and discovery can filter by minimum rating', async () => {
      const first = await publicList('?limit=2').expect(200);
      expect(first.body.data).toHaveLength(2);
      const next = await publicList(`?limit=2&cursor=${first.body.meta.next_cursor}`).expect(200);
      expect(next.body.data[0].id < first.body.data[1].id).toBe(true);
      const avg = (await searchRating()).average!;
      const none = await t.http.get(`/api/v1/search/providers?lat=18.53&lng=73.85&radius_m=5000&min_rating=${Math.min(5, avg + 0.5)}`).expect(200);
      expect(none.body.data.find((r: { location_id: string }) => r.location_id === salon.locationId)).toBeUndefined();
    });
  });

  describe('the business', () => {
    it('reads its reviews and replies once in public; the reply shows under the review', async () => {
      const list = await w.get(`/providers/${salon.providerId}/reviews`, salon.owner);
      expect(list.status).toBe(200);
      const review = list.body.data[0];
      expect(review).toMatchObject({ status: 'PUBLISHED', location_id: salon.locationId });

      const reply = await w.post(`/providers/${salon.providerId}/reviews/${review.id}/reply`, salon.owner, { text: 'Thank you for visiting!' });
      expect(reply.status).toBe(200);
      expect(reply.body.data.reply.text).toBe('Thank you for visiting!');
      const pub = await publicList().expect(200);
      expect(pub.body.data.find((r: { id: string }) => r.id === review.id).reply.text).toBe('Thank you for visiting!');
      expect((await w.post(`/providers/${salon.providerId}/reviews/${review.id}/reply`, salon.owner, { text: '   ' })).status).toBe(409); // empty
    });

    it('is private to the business: outsiders and customers cannot read or answer', async () => {
      Object.assign(admin, await t.reloginAdmin(admin)); // the clock has moved on: the admin token the world uses must be fresh
      const outsider = await w.createSalon('Other Salon');
      const customer = await w.customer(0);
      const reviewId = (await w.get(`/providers/${salon.providerId}/reviews`, salon.owner)).body.data[0].id;
      expect([403, 404]).toContain((await w.get(`/providers/${salon.providerId}/reviews`, outsider.owner)).status);
      expect([403, 404]).toContain((await w.post(`/providers/${salon.providerId}/reviews/${reviewId}/reply`, outsider.owner, { text: 'hi' })).status);
      expect([403, 404]).toContain((await w.get(`/providers/${salon.providerId}/reviews`, customer)).status);
    });

    it('is told about a new review', async () => {
      await w.drain();
      const n = await t.pool.query(`SELECT title FROM notification.notifications WHERE user_id = $1 AND kind = 'REVIEW_RECEIVED' LIMIT 1`, [salon.owner.userId]);
      expect(n.rows[0].title).toMatch(/New \d-star review/);
    });
  });

  describe('moderation', () => {
    it('hiding removes a review from the public list and the rating (and says why to the author); restoring brings it back; all audited', async () => {
      const target = (await w.get(`/providers/${salon.providerId}/reviews`, salon.owner)).body.data.find((r: { rating: number }) => r.rating === 4);
      const before = await searchRating();

      let h = await adminToken();
      const hidden = await t.http.post(`/api/v1/admin/reviews/${target.id}/hide`).set(h).send({ reason: 'Contains personal details of staff' }).expect(200);
      expect(hidden.body.data).toMatchObject({ status: 'HIDDEN', hidden_reason: 'Contains personal details of staff' });
      const pub = await publicList('?limit=50').expect(200);
      expect(pub.body.data.find((r: { id: string }) => r.id === target.id)).toBeUndefined();
      const during = await searchRating();
      expect(during.count).toBe(before.count - 1);

      await t.http.post(`/api/v1/admin/reviews/${target.id}/hide`).set(h).send({ reason: 'again' }).expect(409);
      expect((await w.post(`/providers/${salon.providerId}/reviews/${target.id}/reply`, salon.owner, { text: 'no' })).status).toBe(409); // cannot answer a hidden review
      const own = await w.get(`/appointments/${target.booking_id}/review`, await customerOf(target.booking_id));
      expect(own.body.data).toMatchObject({ status: 'HIDDEN', hidden_reason: 'Contains personal details of staff' });
      expect((await w.put(`/appointments/${target.booking_id}/review`, await customerOf(target.booking_id), { rating: 5 })).status).toBe(409); // cannot edit around moderation

      h = await adminToken();
      await t.http.post(`/api/v1/admin/reviews/${target.id}/unhide`).set(h).expect(200);
      expect((await searchRating()).count).toBe(before.count);
      h = await adminToken(); // authenticate FIRST, build the request second (STATUS D9)
      await t.http.post(`/api/v1/admin/reviews/${target.id}/unhide`).set(h).expect(409);

      const audit = await t.pool.query(`SELECT action, metadata->>'reason' AS reason FROM audit.audit_logs WHERE entity_id = $1 ORDER BY id`, [target.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['review.hidden', 'review.restored']);
      expect(audit.rows[0].reason).toBe('Contains personal details of staff');
    });

    it('is for moderators only (admin and support); the list can be filtered', async () => {
      const customer = await w.customer(0);
      const reviewId = (await publicList().expect(200)).body.data[0].id;
      await t.http.post(`/api/v1/admin/reviews/${reviewId}/hide`).set({ Authorization: `Bearer ${customer.token}` }).send({ reason: 'nope nope' }).expect(403);
      await t.http.get('/api/v1/admin/reviews').expect(401);

      const s = await t.reloginAdmin(support);
      const list = await t.http.get('/api/v1/admin/reviews?status=PUBLISHED&rating=5').set(bearer(s)).expect(200);
      expect(list.body.data.every((r: { status: string; rating: number }) => r.status === 'PUBLISHED' && r.rating === 5)).toBe(true);
      expect(list.body.data[0]).toHaveProperty('customer_id'); // moderators may see who wrote it
      const s2 = await t.reloginAdmin(support);
      await t.http.post(`/api/v1/admin/reviews/${reviewId}/hide`).set(bearer(s2)).send({ reason: 'x' }).expect(422); // reason too short
    });
  });
});
