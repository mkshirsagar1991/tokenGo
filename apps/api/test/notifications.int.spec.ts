import { ConsolePushProvider, NotificationService, PushProvider } from '../src/modules/notifications';
import type { Draft } from '../src/modules/notifications';
import { OutboxService, UnitOfWork } from '../src/shared-kernel';
import { AdminSession, TestApp, bootTestApp } from './support/app';
import { BookingWorld, NOW, Salon, User, bookingWorld, ist } from './support/booking-world';

const MIN = 60_000;
const CUSTOMER_TOKEN = 'customer-device-token-0001';
const OWNER_TOKEN = 'provider-device-token-0001';

describe('Notifications: in-app inbox, push delivery, reminders, preferences, retries (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let w: BookingWorld;
  let admin: AdminSession;
  let support: AdminSession;
  let push: ConsolePushProvider;
  let salon: Salon;
  let alice: User;

  const kindsFor = async (userId: string, audience: 'CUSTOMER' | 'PROVIDER') =>
    (await t.pool.query('SELECT kind FROM notification.notifications WHERE user_id = $1 AND audience = $2 ORDER BY id', [userId, audience])).rows.map((r) => r.kind as string);
  const pushesTo = (token: string) => push.sent.filter((m) => m.token === token);
  const inbox = async (u: User, audience: 'CUSTOMER' | 'PROVIDER', extra = '') => (await w.get(`/notifications?audience=${audience}${extra}`, u)).body;
  const draft = (over: Partial<Draft> = {}): Draft => ({ audience: 'CUSTOMER', category: 'BOOKING', kind: 'TEST', title: 'Test', body: 'A test notification', data: {}, dedupeKey: `test:${Math.random()}`, ...over });
  const register = (u: User, app: 'CUSTOMER' | 'PROVIDER', token: string) => w.post('/devices', u, { app, platform: 'ANDROID', token });

  beforeAll(async () => {
    t = await bootTestApp();
    t.clock.set(NOW);
    push = t.app.get(PushProvider) as ConsolePushProvider;
    admin = await t.loginAdmin({ phone: '9600099999', email: 'admin@example.com' });
    support = await t.loginAdmin({ phone: '9600099998', email: 'support@example.com', roles: ['SUPPORT_OPERATOR'] });
    w = bookingWorld(t, () => admin, '96');
    salon = await w.createSalon('Notify Salon');
    alice = await w.customer(1000);
  });
  afterAll(() => t?.close());

  describe('devices', () => {
    it('registers a push token for the signed-in person, validates it, and moves it if another account signs in on the same phone', async () => {
      const ok = await register(alice, 'CUSTOMER', CUSTOMER_TOKEN);
      expect(ok.status).toBe(200);
      expect((await register(salon.owner, 'PROVIDER', OWNER_TOKEN)).status).toBe(200);
      expect((await register(alice, 'CUSTOMER', 'short')).status).toBe(422);
      expect((await w.post('/devices', alice, { app: 'ADMIN', platform: 'ANDROID', token: CUSTOMER_TOKEN })).status).toBe(422);

      // Shared phone: bob signs in on the device alice used. The token now belongs to bob; alice no longer receives bob's news.
      const bob = await w.customer(0);
      await register(bob, 'CUSTOMER', CUSTOMER_TOKEN);
      const rows = (await t.pool.query('SELECT user_id FROM notification.devices WHERE revoked_at IS NULL AND app = $1', ['CUSTOMER'])).rows;
      expect(rows).toEqual([{ user_id: bob.userId }]);
      await register(alice, 'CUSTOMER', CUSTOMER_TOKEN); // and back again
      expect((await t.pool.query('SELECT count(*) AS n FROM notification.devices')).rows[0].n).toBe('2');
    });

    it('never stores the token in the clear', async () => {
      const row = (await t.pool.query('SELECT token_hash, token_enc FROM notification.devices LIMIT 1')).rows[0];
      expect(Buffer.from(row.token_enc).toString('utf8')).not.toContain('device-token');
      expect(row.token_hash).not.toContain('device-token');
    });

    it('unregisters at sign-out, only for the owner of the token', async () => {
      const carol = await w.customer(0);
      await register(carol, 'CUSTOMER', 'carol-device-token-000001');
      const bob = await w.customer(0);
      expect((await w.post('/devices/unregister', bob, { token: 'carol-device-token-000001' })).body.data.unregistered).toBe(false);
      expect((await w.post('/devices/unregister', carol, { token: 'carol-device-token-000001' })).body.data.unregistered).toBe(true);
    });
  });

  describe('a booking from request to settlement', () => {
    let bookingId: string;
    const startAt = new Date(ist(13, '10:00'));

    it('tells the SALON about a request (and not the customer, who just made it)', async () => {
      const b = await w.bookOk(alice, salon, ist(13, '10:00'));
      bookingId = b.id;
      await w.drain();
      expect(await kindsFor(salon.owner.userId, 'PROVIDER')).toEqual(['BOOKING_REQUESTED']);
      expect(await kindsFor(alice.userId, 'CUSTOMER')).not.toContain('BOOKING_REQUESTED'); // (her wallet top-up is a separate, earlier notification)
      const sent = pushesTo(OWNER_TOKEN);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ title: 'New booking request', data: { booking_id: bookingId, kind: 'BOOKING_REQUESTED' } });
      expect(pushesTo(CUSTOMER_TOKEN).filter((m) => m.data['kind'] === 'BOOKING_REQUESTED')).toHaveLength(0);
    });

    it('tells the CUSTOMER when it is confirmed, with the location\'s own time (10:00 AM, not the phone\'s)', async () => {
      expect((await w.act('approve', bookingId, salon.owner)).status).toBe(200);
      await w.drain();
      expect(await kindsFor(alice.userId, 'CUSTOMER')).toContain('BOOKING_CONFIRMED');
      const msg = pushesTo(CUSTOMER_TOKEN).find((m) => m.data['kind'] === 'BOOKING_CONFIRMED')!;
      expect(msg.title).toBe('Booking confirmed');
      expect(msg.body).toContain('Tue, 13 Oct · 10:00 AM');
    });

    it('sends ONE reminder to each side shortly before the appointment, never twice', async () => {
      const due = (await t.pool.query(`SELECT available_at FROM platform.outbox_events WHERE event_type = 'booking.reminder_due' AND aggregate_id = $1`, [bookingId])).rows;
      expect(due).toHaveLength(1);
      expect(new Date(due[0].available_at).getTime()).toBe(startAt.getTime() - 120 * MIN); // the default lead time

      t.clock.set(new Date(startAt.getTime() - 119 * MIN));
      await w.drain();
      expect(await kindsFor(alice.userId, 'CUSTOMER')).toContain('APPOINTMENT_REMINDER');
      expect(await kindsFor(salon.owner.userId, 'PROVIDER')).toContain('APPOINTMENT_REMINDER');
      await w.drain();
      expect((await kindsFor(alice.userId, 'CUSTOMER')).filter((k) => k === 'APPOINTMENT_REMINDER')).toHaveLength(1);
    });

    it('then follows the service: started, completed (confirm please), and after settlement the salon is paid and the customer is asked for a review', async () => {
      await w.runToCompleted({ id: bookingId }, alice, salon, startAt);
      await w.drain();
      expect(await kindsFor(alice.userId, 'CUSTOMER')).toEqual(expect.arrayContaining(['SERVICE_STARTED', 'SERVICE_COMPLETED']));

      expect((await w.act('confirm-completion', bookingId, alice)).status).toBe(200);
      await w.drain();
      expect(await kindsFor(salon.owner.userId, 'PROVIDER')).toContain('PAYMENT_RECORDED');
      expect(await kindsFor(alice.userId, 'CUSTOMER')).toContain('REVIEW_REQUESTED');
      const payment = (await t.pool.query(`SELECT body FROM notification.notifications WHERE user_id = $1 AND kind = 'PAYMENT_RECORDED'`, [salon.owner.userId])).rows[0];
      expect(payment.body).toMatch(/₹\d+/);
    });
  });

  describe('cancellations', () => {
    it('a customer cancellation tells the salon, and the booking\'s reminder is then silent', async () => {
      const bob = await w.customer(1000);
      const b = await w.bookOk(bob, salon, ist(14, '11:00'));
      await w.act('approve', b.id, salon.owner);
      expect((await w.act('cancel', b.id, bob)).status).toBe(200);
      await w.drain();
      expect(await kindsFor(salon.owner.userId, 'PROVIDER')).toContain('BOOKING_CANCELLED_BY_CUSTOMER');

      t.clock.set(new Date(new Date(ist(14, '11:00')).getTime() - 100 * MIN));
      await w.drain();
      const reminders = (await t.pool.query(`SELECT count(*) AS n FROM notification.notifications WHERE dedupe_key = $1`, [`reminder:${b.id}`])).rows[0].n;
      expect(reminders).toBe('0');
    });

    it('a salon cancellation tells the customer they are refunded in full', async () => {
      t.clock.set(NOW);
      const dave = await w.customer(1000);
      const b = await w.bookOk(dave, salon, ist(15, '10:00'));
      await w.act('approve', b.id, salon.owner);
      expect((await w.act('provider-cancel', b.id, salon.owner, { reason_code: 'UNAVAILABLE' })).status).toBe(200);
      await w.drain();
      const n = (await t.pool.query(`SELECT body FROM notification.notifications WHERE user_id = $1 AND kind = 'BOOKING_CANCELLED_BY_SALON'`, [dave.userId])).rows[0];
      expect(n.body).toMatch(/refunded in full/);
    });
  });

  describe('the inbox', () => {
    it('lists newest first, keeps the two apps\' audiences apart, paginates, counts unread, and marks read', async () => {
      const mine = await inbox(alice, 'CUSTOMER', '&limit=2');
      expect(mine.data).toHaveLength(2);
      expect(mine.meta.next_cursor).toEqual(expect.any(String));
      const second = await inbox(alice, 'CUSTOMER', `&limit=2&cursor=${mine.meta.next_cursor}`);
      expect(second.data[0].id < mine.data[1].id).toBe(true);
      expect(await inbox(alice, 'PROVIDER')).toMatchObject({ data: [] }); // alice owns no business: nothing in that app

      const unread = (await w.get('/notifications/unread-count?audience=CUSTOMER', alice)).body.data.count;
      expect(unread).toBeGreaterThanOrEqual(5);
      const one = (await w.post(`/notifications/${mine.data[0].id}/read`, alice)).body.data;
      expect(one.read_at).not.toBeNull();
      expect((await w.get('/notifications/unread-count?audience=CUSTOMER', alice)).body.data.count).toBe(unread - 1);
      expect(await inbox(alice, 'CUSTOMER', '&unread=true&limit=50').then((r) => r.data.every((n: { read_at: unknown }) => n.read_at === null))).toBe(true);

      const all = (await w.post('/notifications/read-all', alice, { audience: 'CUSTOMER' })).body.data.updated;
      expect(all).toBe(unread - 1);
      expect((await w.get('/notifications/unread-count?audience=CUSTOMER', alice)).body.data.count).toBe(0);
    });

    it('is private: another person\'s notification is a 404, and everything needs a sign-in and a valid audience', async () => {
      const bob = await w.customer(0);
      const aliceNote = (await inbox(alice, 'CUSTOMER', '&limit=1')).data[0];
      expect((await w.post(`/notifications/${aliceNote.id}/read`, bob)).status).toBe(404);
      await t.http.get('/api/v1/notifications?audience=CUSTOMER').expect(401);
      expect((await w.get('/notifications', alice)).status).toBe(422); // audience is required
      expect((await w.get('/notifications?audience=ADMIN', alice)).status).toBe(422);
    });
  });

  describe('preferences', () => {
    it('muting a category stops the push but never hides the notification from the inbox', async () => {
      const erin = await w.customer(1000);
      await register(erin, 'CUSTOMER', 'erin-device-token-00000001');
      const prefs = (await w.get('/notifications/preferences', erin)).body.data as { category: string; push_enabled: boolean }[];
      expect(prefs).toHaveLength(6);
      expect(prefs.every((p) => p.push_enabled)).toBe(true);

      await w.put('/notifications/preferences', erin, { category: 'BOOKING', push_enabled: false });
      await w.drain(); // her funding already produced a wallet notification; count only what follows
      const before = pushesTo('erin-device-token-00000001').length;
      const b = await w.bookOk(erin, salon, ist(16, '10:00'));
      await w.act('approve', b.id, salon.owner);
      await w.drain();
      expect(await kindsFor(erin.userId, 'CUSTOMER')).toContain('BOOKING_CONFIRMED'); // in the inbox
      expect(pushesTo('erin-device-token-00000001')).toHaveLength(before); // but no push

      await w.put('/notifications/preferences', erin, { category: 'BOOKING', push_enabled: true });
      expect((await w.put('/notifications/preferences', erin, { category: 'NOPE', push_enabled: true })).status).toBe(422);
    });
  });

  describe('delivery resilience', () => {
    it('retries a transient push failure later without re-sending to devices that already got it, and retires a dead device', async () => {
      const fay = await w.customer(0);
      await register(fay, 'CUSTOMER', 'good-device-token-000000001');
      await register(fay, 'CUSTOMER', 'flaky-device-token-00000001');
      await register(fay, 'CUSTOMER', 'invalid-device-token-0000001');

      await t.app.get(NotificationService).notify([{ userId: fay.userId, draft: draft({ dedupeKey: 'resilience-1', title: 'Hello Fay' }) }]);
      await w.drain();

      // Good device: delivered. Dead device: retired. Flaky device: told to try again — the event is waiting for its backoff.
      expect(pushesTo('good-device-token-000000001')).toHaveLength(1);
      const status = async () => Object.fromEntries((await t.pool.query(`SELECT dev.platform, d.status, d.attempts, dev.revoked_at IS NOT NULL AS revoked FROM notification.deliveries d JOIN notification.devices dev ON dev.id = d.device_id JOIN notification.notifications n ON n.id = d.notification_id WHERE n.user_id = $1 ORDER BY d.id`, [fay.userId])).rows.map((r, i) => [i, r]));
      const rows = Object.values(await status()) as { status: string; attempts: number; revoked: boolean }[];
      expect(rows.map((r) => r.status).sort()).toEqual(['FAILED', 'PENDING', 'SENT']);
      expect(rows.find((r) => r.status === 'FAILED')).toMatchObject({ revoked: true });
      expect(pushesTo('flaky-device-token-00000001')).toHaveLength(0);

      t.clock.advanceSeconds(3 * 3600); // past the outbox backoff
      await w.drain();
      expect(pushesTo('flaky-device-token-00000001')).toHaveLength(1); // delivered on the retry
      expect(pushesTo('good-device-token-000000001')).toHaveLength(1); // NOT sent a second time
      const final = (await t.pool.query(`SELECT d.status FROM notification.deliveries d JOIN notification.notifications n ON n.id = d.notification_id WHERE n.user_id = $1`, [fay.userId])).rows.map((r) => r.status as string);
      expect(final.sort()).toEqual(['FAILED', 'SENT', 'SENT']);
    });

    it('a replayed event never notifies twice (dedupe)', async () => {
      const gus = await w.customer(1000);
      const b = await w.bookOk(gus, salon, ist(16, '14:00'));
      await w.act('approve', b.id, salon.owner);
      await w.drain();
      const uow = t.app.get(UnitOfWork);
      await uow.run(() => t.app.get(OutboxService).publish({ type: 'booking.approved', aggregateType: 'booking', aggregateId: b.id, payload: { booking_id: b.id, customer_id: gus.userId, provider_id: salon.providerId, location_id: salon.locationId } }));
      await w.drain();
      expect((await kindsFor(gus.userId, 'CUSTOMER')).filter((k) => k === 'BOOKING_CONFIRMED')).toHaveLength(1);
    });

    it('an inactive account is never notified', async () => {
      const hal = await w.customer(0);
      await t.pool.query("UPDATE identity.users SET status = 'SUSPENDED' WHERE id = $1", [hal.userId]);
      expect(await t.app.get(NotificationService).notify([{ userId: hal.userId, draft: draft() }])).toBe(0);
    });
  });

  describe('operators', () => {
    it('can see delivery health (counts and failures) but never message text or tokens; customers cannot', async () => {
      const fresh = await t.reloginAdmin(support);
      const res = await t.http.get('/api/v1/admin/notifications/deliveries?status=FAILED').set({ Authorization: `Bearer ${fresh.accessToken}` }).expect(200);
      expect(res.body.meta.totals).toMatchObject({ SENT: expect.any(Number), FAILED: expect.any(Number) });
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body)).not.toMatch(/device-token|Hello Fay|booking_id/);
      expect((await w.get('/admin/notifications/deliveries', alice)).status).toBe(403);
      await t.http.get('/api/v1/admin/notifications/deliveries').expect(401);
    });
  });

  describe('account deletion', () => {
    it('removes the person\'s notifications, devices and preferences', async () => {
      const ivy = await w.customer(0);
      await register(ivy, 'CUSTOMER', 'ivy-device-token-0000000001');
      await w.put('/notifications/preferences', ivy, { category: 'WALLET', push_enabled: false });
      await t.app.get(NotificationService).notify([{ userId: ivy.userId, draft: draft({ dedupeKey: 'ivy-1' }) }]);
      expect((await t.pool.query('SELECT count(*) AS n FROM notification.notifications WHERE user_id = $1', [ivy.userId])).rows[0].n).toBe('1');

      expect((await w.post('/users/me/deletion-request', ivy)).status).toBe(200);
      t.clock.advanceSeconds(8 * 86_400);
      await w.drain();
      for (const table of ['notifications', 'devices', 'preferences']) {
        expect((await t.pool.query(`SELECT count(*) AS n FROM notification.${table} WHERE user_id = $1`, [ivy.userId])).rows[0].n).toBe('0');
      }
      expect((await t.pool.query('SELECT status FROM identity.users WHERE id = $1', [ivy.userId])).rows[0].status).toBe('DELETED');
    });
  });
});
