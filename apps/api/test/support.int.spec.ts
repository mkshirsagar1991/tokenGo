import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerIntegrityService } from '../src/modules/wallet-ledger';
import { AdminSession, TestApp, bootTestApp } from './support/app';
import { BookingWorld, NOW, Salon, User, bookingWorld, ist } from './support/booking-world';

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);

describe('Support & disputes: opening, freezing the money, privacy, evidence, the decision and its limits (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let w: BookingWorld;
  let admin: AdminSession;
  let operator: AdminSession;
  let salon: Salon;
  let dir: string;
  const bearer = (a: { accessToken: string }) => ({ Authorization: `Bearer ${a.accessToken}` });
  const secondsLeft = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp as number) - t.clock.now().getTime() / 1000;
  /** The session is refreshed IN PLACE (the booking world holds the same object), and only when the token is about to lapse. */
  const sessionHeader = async (a: AdminSession) => {
    if (secondsLeft(a.accessToken) < 90) Object.assign(a, await t.reloginAdmin(a));
    return bearer(a);
  };
  const adminHeader = () => sessionHeader(admin);
  const operatorHeader = () => sessionHeader(operator);
  /** The header is an ARGUMENT, so it is awaited before the request exists: supertest listens when a request is created (D9). */
  const asReq = (method: 'get' | 'post' | 'put', url: string, h: { Authorization: string }) => t.http[method](url).set(h);
  const expectLedgerOk = async () => expect((await t.app.get(LedgerIntegrityService).check()).violations).toEqual([]);

  let slotSeq = 0;
  const nextSlot = () => {
    const i = slotSeq++;
    const minutes = 9 * 60 + (i % 6) * 90;
    return { day: 13 + Math.floor(i / 6), hhmm: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
  };

  /** A booking taken to "service completed" (money still held, waiting for the customer or the window). */
  async function completed(funds = 1000) {
    const { day, hhmm } = nextSlot();
    const customer = await w.customer(funds);
    const b = await w.bookOk(customer, salon, ist(day, hhmm));
    expect((await w.act('approve', b.id, salon.owner)).status).toBe(200);
    await w.runToCompleted(b, customer, salon, new Date(ist(day, hhmm)));
    return { customer, booking: b };
  }
  const dispute = (c: User, bookingId: string, body: object = { category: 'POOR_QUALITY', message: 'The haircut was not what we agreed.' }) => w.post(`/appointments/${bookingId}/dispute`, c, body);
  async function disputed(funds = 1000) {
    const { customer, booking } = await completed(funds);
    const res = await dispute(customer, booking.id);
    expect(res.status).toBe(201);
    return { customer, booking, caseId: res.body.data.id as string };
  }
  const bookingRow = async (id: string) => (await t.pool.query('SELECT status, settlement_status, funds_status FROM booking.bookings WHERE id = $1', [id])).rows[0] as { status: string; settlement_status: string; funds_status: string };
  const adminCase = async (caseId: string) => asReq('get', `/api/v1/admin/support/cases/${caseId}`, await adminHeader());
  const decide = async (header: { Authorization: string }, caseId: string, body: object) => t.http.post(`/api/v1/admin/support/cases/${caseId}/resolve-dispute`).set(header).send(body);
  const setLimit = async (value: number) => {
    await asReq('put', '/api/v1/admin/settings/disputes.operator_limit_minor', await adminHeader()).send({ value }).expect(200);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tokengo-support-'));
    t = await bootTestApp({ STORAGE_LOCAL_DIR: dir, MAX_UPLOAD_BYTES: '20000' });
    t.clock.set(NOW);
    admin = await t.loginAdmin({ phone: '9700099999', email: 'admin@example.com' });
    operator = await t.loginAdmin({ phone: '9700099998', email: 'operator@example.com', roles: ['SUPPORT_OPERATOR'] });
    w = bookingWorld(t, () => admin, '97');
    salon = await w.createSalon('Dispute Salon');
  });
  afterAll(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('raising a dispute', () => {
    it('freezes settlement, creates a case both sides can see, and the worker no longer settles it', async () => {
      const { customer, booking } = await completed();
      expect(await w.wallet(customer)).toEqual({ available: 800, held: 200 });
      const res = await dispute(customer, booking.id);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ kind: 'DISPUTE', status: 'OPEN', category: 'POOR_QUALITY', booking_id: booking.id, opened_by_role: 'CUSTOMER', resolution: null });
      expect(res.body.data.reference).toMatch(/^SUP-[0-9A-Z]{8}$/);
      expect(await bookingRow(booking.id)).toMatchObject({ status: 'DISPUTED', settlement_status: 'FROZEN' });
      expect(await w.wallet(customer)).toEqual({ available: 800, held: 200 }); // the money stays held until a decision

      // the business hears about it, and can read the case
      await w.drain();
      const owner = (await w.get('/notifications?audience=PROVIDER&limit=10', salon.owner)).body.data as { kind: string }[];
      expect(owner.map((n) => n.kind)).toContain('DISPUTE_OPENED');
      expect((await w.get(`/support/cases/${res.body.data.id}`, salon.owner)).status).toBe(200);
      await expectLedgerOk();
    });

    it('is only possible for the booking’s own customer, while the service is completed', async () => {
      const { booking } = await completed();
      const stranger = await w.customer(0);
      expect((await dispute(stranger, booking.id)).status).toBe(404); // not yours = does not exist
      expect((await dispute(salon.owner, booking.id)).status).toBe(404); // the business cannot dispute its own service
      await t.http.post(`/api/v1/appointments/${booking.id}/dispute`).send({ category: 'OTHER', message: 'x' }).expect(401);
      expect((await bookingRow(booking.id)).status).toBe('SERVICE_COMPLETED');

      // not completed yet
      const c2 = await w.customer(1000);
      const { day, hhmm } = nextSlot();
      const early = await w.bookOk(c2, salon, ist(day, hhmm));
      const tooEarly = await dispute(c2, early.id);
      expect(tooEarly.status).toBe(409);
    });

    it('validates the report and honours the feature flag', async () => {
      const { customer, booking } = await completed();
      expect((await dispute(customer, booking.id, { category: 'NONSENSE', message: 'x' })).status).toBe(422);
      expect((await dispute(customer, booking.id, { category: 'OTHER', message: '   ' })).status).toBe(422);
      expect((await dispute(customer, booking.id, { category: 'OTHER' })).status).toBe(422);
      expect((await bookingRow(booking.id)).status).toBe('SERVICE_COMPLETED'); // nothing frozen by a rejected report

      await asReq('put', '/api/v1/admin/settings/features.disputes_enabled', await adminHeader()).send({ value: false }).expect(200);
      const off = await dispute(customer, booking.id);
      expect(off.status).toBe(409);
      expect(off.body.code).toBe('DISPUTES_DISABLED');
      await asReq('put', '/api/v1/admin/settings/features.disputes_enabled', await adminHeader()).send({ value: true }).expect(200);
      expect((await dispute(customer, booking.id)).status).toBe(201);
    });

    it('can be raised once per booking', async () => {
      const { customer, booking } = await disputed();
      const again = await dispute(customer, booking.id);
      expect(again.status).toBe(409);
      expect((await t.pool.query("SELECT count(*)::int AS n FROM support.cases WHERE booking_id = $1 AND kind = 'DISPUTE'", [booking.id])).rows[0].n).toBe(1);
    });
  });

  describe('who can see a case', () => {
    it('shows it to the customer and the business, never to anyone else, and hides staff notes', async () => {
      const { customer, caseId } = await disputed();
      const stranger = await w.customer(0);
      await adminHeader(); // the booking world approves with this session: refresh it if the test clock has outrun it
      const otherOwner = (await w.createSalon('Other Salon')).owner;
      for (const outsider of [stranger, otherOwner]) {
        expect((await w.get(`/support/cases/${caseId}`, outsider)).status).toBe(404);
        expect((await w.post(`/support/cases/${caseId}/messages`, outsider, { message: 'hello' })).status).toBe(404);
      }
      await t.http.get(`/api/v1/support/cases/${caseId}`).expect(401);

      await asReq('post', `/api/v1/admin/support/cases/${caseId}/messages`, await adminHeader()).send({ message: 'Looks like the salon is at fault.', internal: true }).expect(201);
      await asReq('post', `/api/v1/admin/support/cases/${caseId}/messages`, await adminHeader()).send({ message: 'We are looking into this.' }).expect(201);

      for (const party of [customer, salon.owner]) {
        const msgs = (await w.get(`/support/cases/${caseId}`, party)).body.data.messages as { body: string; author_role: string }[];
        expect(msgs.map((m) => m.body)).toContain('We are looking into this.');
        expect(JSON.stringify(msgs)).not.toContain('salon is at fault');
      }
      const staff = (await adminCase(caseId)).body.data.messages as { body: string; internal: boolean }[];
      expect(staff.find((m) => m.body.includes('at fault'))?.internal).toBe(true);
    });

    it('lists "my cases" per side, and keeps a question private to the side that asked it', async () => {
      const { customer, caseId } = await disputed();
      const q = await w.post('/support/cases', customer, { audience: 'CUSTOMER', category: 'PAYMENT', subject: 'Where is my refund?', message: 'Asking about a wallet top-up.' });
      expect(q.status).toBe(201);
      expect(q.body.data.kind).toBe('QUESTION');

      const mine = (await w.get('/support/cases?audience=CUSTOMER', customer)).body.data as { id: string }[];
      expect(mine.map((c) => c.id).sort()).toEqual([caseId, q.body.data.id].sort());

      const theirs = await w.get(`/support/cases?audience=PROVIDER&provider_id=${salon.providerId}`, salon.owner);
      expect(theirs.status).toBe(200);
      const ids = (theirs.body.data as { id: string }[]).map((c) => c.id);
      expect(ids).toContain(caseId);
      expect(ids).not.toContain(q.body.data.id);
      expect((await w.get(`/support/cases/${q.body.data.id}`, salon.owner)).status).toBe(404);

      // someone cannot list as a business they have nothing to do with
      const stranger = await w.customer(0);
      expect((await w.get(`/support/cases?audience=PROVIDER&provider_id=${salon.providerId}`, stranger)).status).toBe(404);
    });

    it('the business can write as itself, for its own business only', async () => {
      const q = await w.post('/support/cases', salon.owner, { audience: 'PROVIDER', provider_id: salon.providerId, category: 'ACCOUNT', subject: 'Update my bank account', message: 'How do I change it?' });
      expect(q.status).toBe(201);
      expect((await w.get(`/support/cases/${q.body.data.id}`, salon.owner)).status).toBe(200);
      const stranger = await w.customer(0);
      expect((await w.post('/support/cases', stranger, { audience: 'PROVIDER', provider_id: salon.providerId, category: 'ACCOUNT', subject: 'Sneaky', message: 'x' })).status).toBeGreaterThanOrEqual(403);
      expect((await w.post('/support/cases', stranger, { audience: 'CUSTOMER', category: 'BOOKING', subject: 'About a booking', message: 'x', booking_id: (await completed()).booking.id })).status).toBe(404);
    });
  });

  describe('messages and evidence', () => {
    it('both sides talk; a reply from staff reaches the right people; closed cases take no more messages', async () => {
      const { customer, caseId } = await disputed();
      await w.drain();
      expect((await w.post(`/support/cases/${caseId}/messages`, salon.owner, { message: 'We did exactly what was booked.' })).status).toBe(201);
      await asReq('post', `/api/v1/admin/support/cases/${caseId}/messages`, await adminHeader()).send({ message: 'Can you share a photo?', awaiting: 'CUSTOMER' }).expect(201);
      expect((await adminCase(caseId)).body.data.status).toBe('AWAITING_CUSTOMER');
      await w.drain();
      const kinds = (await w.get('/notifications?audience=CUSTOMER&limit=20', customer)).body.data.map((n: { kind: string }) => n.kind);
      expect(kinds).toContain('SUPPORT_REPLY');
      expect((await w.post(`/support/cases/${caseId}/messages`, customer, { message: 'Here you go.' })).status).toBe(201);
      expect((await adminCase(caseId)).body.data.status).toBe('IN_REVIEW'); // answered: back in the team's hands

      // an undecided dispute cannot simply be closed: its money is frozen
      const close = await asReq('post', `/api/v1/admin/support/cases/${caseId}/close`, await adminHeader()).send({});
      expect(close.status).toBe(409);
      expect(close.body.code).toBe('DISPUTE_UNDECIDED');
    });

    it('accepts images and PDFs by content, refuses anything else, and serves files only to the case’s people as downloads', async () => {
      const { customer, caseId } = await disputed();
      const up = async (u: User, file: Buffer, mime = 'image/jpeg', filename = 'photo.jpg') => {
        const h = await w.auth(u);
        return t.http.post(`/api/v1/support/cases/${caseId}/attachments`).set(h).attach('file', file, { filename, contentType: mime });
      };
      const ok = await up(customer, jpeg());
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ content_type: 'image/jpeg', uploaded_by_role: 'CUSTOMER' });
      expect(JSON.stringify(ok.body)).not.toContain('case-evidence/'); // the storage key is never exposed

      expect((await up(customer, Buffer.from('<script>alert(1)</script>'), 'image/jpeg', 'evil.jpg')).status).toBe(422); // lies about its type
      expect((await up(customer, Buffer.alloc(30_000, 1))).status).toBe(422); // over the configured size
      const stranger = await w.customer(0);
      expect((await up(stranger, jpeg())).status).toBe(404);

      const id = ok.body.data.id as string;
      const file = await (async () => t.http.get(`/api/v1/support/cases/${caseId}/attachments/${id}`).set(await w.auth(salon.owner)))();
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toMatch(/^attachment;/);
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect((await w.get(`/support/cases/${caseId}/attachments/${id}`, stranger)).status).toBe(404);
      const staffFile = await asReq('get', `/api/v1/admin/support/cases/${caseId}/attachments/${id}`, await adminHeader());
      expect(staffFile.status).toBe(200);
      const viewed = await t.pool.query("SELECT 1 FROM audit.audit_logs WHERE action = 'support.attachment_viewed' AND entity_id = $1", [caseId]);
      expect(viewed.rowCount).toBe(1);
    });
  });

  describe('the decision: money moves exactly as decided, once', () => {
    it('refunds the customer in full', async () => {
      const { customer, booking, caseId } = await disputed();
      const res = await decide(await adminHeader(), caseId, { outcome: 'REFUND_CUSTOMER', note: 'The service was not delivered.' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'RESOLVED', money: { refund: { amount_minor: 20000 }, provider_net: { amount_minor: 0 }, commission: { amount_minor: 0 } } });
      expect(res.body.data.resolution).toMatchObject({ outcome: 'REFUND_CUSTOMER', refund: { amount_minor: 20000 } });
      expect(await w.wallet(customer)).toEqual({ available: 1000, held: 0 });
      expect(await bookingRow(booking.id)).toMatchObject({ status: 'CLOSED', settlement_status: 'DONE', funds_status: 'RELEASED' });
      await w.drain();
      expect((await w.get('/notifications?audience=CUSTOMER&limit=20', customer)).body.data.map((n: { kind: string }) => n.kind)).toContain('DISPUTE_RESOLVED');
      expect((await w.get('/notifications?audience=PROVIDER&limit=20', salon.owner)).body.data.map((n: { kind: string }) => n.kind)).toContain('DISPUTE_RESOLVED');
      await expectLedgerOk();
    });

    it('releases the money to the business, with the platform commission taken', async () => {
      const { customer, booking, caseId } = await disputed();
      const res = await decide(await adminHeader(), caseId, { outcome: 'RELEASE_TO_PROVIDER', note: 'The service was delivered as booked.' });
      expect(res.status).toBe(200);
      const m = res.body.data.money;
      expect(m.refund.amount_minor).toBe(0);
      expect(m.provider_net.amount_minor + m.commission.amount_minor).toBe(20000);
      expect(m.provider_net.amount_minor).toBeGreaterThan(0);
      expect(await w.wallet(customer)).toEqual({ available: 800, held: 0 });
      expect(await bookingRow(booking.id)).toMatchObject({ status: 'CLOSED', funds_status: 'SETTLED' });
      await expectLedgerOk();
    });

    it('splits a partial refund exactly: refund + business + commission = what was held', async () => {
      const { customer, caseId } = await disputed();
      const res = await decide(await adminHeader(), caseId, { outcome: 'PARTIAL_REFUND', refund_minor: 7500, note: 'Half the service was done.' });
      expect(res.status).toBe(200);
      const m = res.body.data.money;
      expect(m.refund.amount_minor).toBe(7500);
      expect(m.refund.amount_minor + m.provider_net.amount_minor + m.commission.amount_minor).toBe(20000);
      expect(await w.wallet(customer)).toEqual({ available: 800 + 75, held: 0 });
      await expectLedgerOk();
    });

    it('rejects impossible or incomplete decisions and moves nothing', async () => {
      const { customer, booking, caseId } = await disputed();
      const h = async () => adminHeader();
      for (const body of [
        { outcome: 'PARTIAL_REFUND', note: 'No amount given for this.' },
        { outcome: 'PARTIAL_REFUND', refund_minor: 0, note: 'Zero is not a partial refund.' },
        { outcome: 'PARTIAL_REFUND', refund_minor: 20000, note: 'That is the full amount, not partial.' },
        { outcome: 'PARTIAL_REFUND', refund_minor: 20001, note: 'More than was ever held.' },
        { outcome: 'PARTIAL_REFUND', refund_minor: 75.5, note: 'Fractions of a paisa do not exist.' },
        { outcome: 'REFUND_EVERYTHING', note: 'Not a real outcome at all.' },
        { outcome: 'REFUND_CUSTOMER', note: 'short' },
        { outcome: 'REFUND_CUSTOMER' },
      ]) {
        expect((await decide(await h(), caseId, body)).status).toBe(422);
      }
      expect(await w.wallet(customer)).toEqual({ available: 800, held: 200 });
      expect((await bookingRow(booking.id)).status).toBe('DISPUTED');
      expect((await adminCase(caseId)).body.data.status).toBe('OPEN');
    });

    it('can be decided only once, even if two administrators click at the same moment', async () => {
      const { customer, caseId } = await disputed();
      const [a, b] = await Promise.all([
        decide(await adminHeader(), caseId, { outcome: 'REFUND_CUSTOMER', note: 'First administrator’s decision.' }),
        decide(await adminHeader(), caseId, { outcome: 'RELEASE_TO_PROVIDER', note: 'Second administrator’s decision.' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('DISPUTE_ALREADY_RESOLVED');
      const wallet = await w.wallet(customer);
      expect(wallet.held).toBe(0);
      expect([800, 1000]).toContain(wallet.available);
      await expectLedgerOk();
    });

    it('lets a support operator decide up to the limit, and only a platform administrator above it', async () => {
      await setLimit(10000); // ₹100
      const big = await disputed();
      const over = await decide(await operatorHeader(), big.caseId, { outcome: 'REFUND_CUSTOMER', note: 'Refund the whole ₹200 service.' });
      expect(over.status).toBe(403);
      expect(over.body.code).toBe('DISPUTE_LIMIT_EXCEEDED');
      expect((await bookingRow(big.booking.id)).status).toBe('DISPUTED'); // nothing moved
      expect(await w.wallet(big.customer)).toEqual({ available: 800, held: 200 });

      const small = await decide(await operatorHeader(), big.caseId, { outcome: 'PARTIAL_REFUND', refund_minor: 10000, note: 'A fair share, within my limit.' });
      expect(small.status).toBe(200);
      expect(small.body.data.decision_limits).toMatchObject({ operator_limit: { amount_minor: 10000 }, can_decide_above_limit: false });

      const another = await disputed();
      expect((await decide(await adminHeader(), another.caseId, { outcome: 'REFUND_CUSTOMER', note: 'Platform administrator decides the large one.' })).status).toBe(200);
      await setLimit(500000);
      await expectLedgerOk();
    });

    it('needs the right permission, and a decision cannot be applied to a question', async () => {
      const { customer, caseId } = await disputed();
      expect((await decide(await w.auth(customer), caseId, { outcome: 'REFUND_CUSTOMER', note: 'Deciding my own dispute for me.' })).status).toBe(403);
      expect((await w.get('/admin/support/cases', customer)).status).toBe(403);
      await t.http.get('/api/v1/admin/support/cases').expect(401);
      const q = await w.post('/support/cases', customer, { audience: 'CUSTOMER', category: 'OTHER', subject: 'Just a question', message: 'Hello support' });
      const res = await decide(await adminHeader(), q.body.data.id, { outcome: 'REFUND_CUSTOMER', note: 'Refunding a question is nonsense.' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_A_DISPUTE');
      expect(await w.wallet(customer)).toEqual({ available: 800, held: 200 });
    });

    it('is fully audited with the reason, and the closed case takes no more messages', async () => {
      const { customer, caseId } = await disputed();
      await decide(await adminHeader(), caseId, { outcome: 'REFUND_CUSTOMER', note: 'Evidence supports the customer.' }).then((r) => expect(r.status).toBe(200));
      const audit = (await t.pool.query("SELECT metadata, before_data, after_data FROM audit.audit_logs WHERE action = 'support.dispute_resolved' AND entity_id = $1", [caseId])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({ refund_minor: 20000, note: 'Evidence supports the customer.' });
      expect(audit[0].after_data).toMatchObject({ status: 'RESOLVED', outcome: 'REFUND_CUSTOMER' });

      const late = await w.post(`/support/cases/${caseId}/messages`, customer, { message: 'One more thing.' });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('CASE_CLOSED');
      const closed = await asReq('post', `/api/v1/admin/support/cases/${caseId}/close`, await adminHeader()).send({ note: 'Closing after the decision.' });
      expect(closed.status).toBe(200);
      expect(closed.body.data.status).toBe('CLOSED');
      expect((await asReq('post', `/api/v1/admin/support/cases/${caseId}/close`, await adminHeader()).send({})).status).toBe(409);
    });
  });

  describe('the staff queue', () => {
    it('filters, assigns to staff only, and shows the booking’s timeline and held amount to the decider', async () => {
      const { caseId, booking } = await disputed();
      const list = await asReq('get', '/api/v1/admin/support/cases?status=OPEN&kind=DISPUTE&assigned=none', await operatorHeader());
      expect(list.status).toBe(200);
      expect((list.body.data as { id: string }[]).map((c) => c.id)).toContain(caseId);

      expect((await asReq('post', `/api/v1/admin/support/cases/${caseId}/assign`, await adminHeader()).send({ assignee_id: salon.owner.userId })).status).toBe(422); // not a staff account
      const assigned = await asReq('post', `/api/v1/admin/support/cases/${caseId}/assign`, await adminHeader()).send({ assignee_id: operator.userId });
      expect(assigned.status).toBe(200);
      expect(assigned.body.data).toMatchObject({ assigned: true, status: 'IN_REVIEW' });
      const mineList = await asReq('get', '/api/v1/admin/support/cases?assigned=me', await operatorHeader());
      expect((mineList.body.data as { id: string }[]).map((c) => c.id)).toContain(caseId);

      const detail = (await asReq('get', `/api/v1/admin/support/cases/${caseId}`, await operatorHeader())).body.data;
      expect(detail.booking).toMatchObject({ id: booking.id, status: 'DISPUTED', price: { amount_minor: 20000 }, held: { amount_minor: 20000 } });
      expect((detail.booking.timeline as { type: string }[]).length).toBeGreaterThan(3);
    });
  });

  describe('time', () => {
    it('refuses a dispute after the window, and an undisputed booking settles as before', async () => {
      const { customer, booking } = await completed();
      t.clock.set(new Date(t.clock.now().getTime() + 30 * 86_400_000));
      const late = await dispute(customer, booking.id);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('DISPUTE_WINDOW_PASSED');
      expect((await bookingRow(booking.id)).status).toBe('SERVICE_COMPLETED');
      await expectLedgerOk();
    });
  });
});
