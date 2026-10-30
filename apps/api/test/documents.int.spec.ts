import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminSession, TestApp, bootTestApp } from './support/app';

const jpeg = (n = 300, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 9)]);
const pdf = (extra = '') => Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\n%%EOF`);
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('Provider documents: upload, validation, access control, review, submission rule (integration, real PostgreSQL, local storage)', () => {
  let t: TestApp;
  let admin: AdminSession;
  let support: AdminSession;
  let dir: string;
  let owner: { userId: string; accessToken: string };
  let providerId: string;
  const as = (u: { accessToken: string }) => ({ Authorization: `Bearer ${u.accessToken}` });
  const upload = (token: { accessToken: string } | null, pid: string, file: Buffer | null, opts: { type?: string; filename?: string; mime?: string } = {}) => {
    let req = t.http.post(`/api/v1/providers/${pid}/documents`);
    if (token) req = req.set(as(token));
    if (opts.type !== undefined) req = req.field('doc_type', opts.type);
    if (file) req = req.attach('file', file, { filename: opts.filename ?? 'scan.jpg', contentType: opts.mime ?? 'image/jpeg' });
    return req;
  };
  const objectCount = () => (existsSync(join(dir, 'provider-documents')) ? readdirSync(join(dir, 'provider-documents')).filter((f) => !f.endsWith('.type')).length : 0);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tokengo-docs-'));
    t = await bootTestApp({ STORAGE_LOCAL_DIR: dir, MAX_UPLOAD_BYTES: '20000' });
    admin = await t.loginAdmin({ phone: '9400099999', email: 'admin@example.com' });
    support = await t.loginAdmin({ phone: '9400099998', email: 'support@example.com', roles: ['SUPPORT_OPERATOR'] });
    owner = await t.login('9400000001');
    providerId = (await t.http.post('/api/v1/providers').set(as(owner)).send({ display_name: 'Docs Salon' }).expect(201)).body.data.id;
  });
  afterAll(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the business uploads', () => {
    it('stores a valid file and shows its metadata — never the storage key or hash', async () => {
      const res = await upload(owner, providerId, jpeg(), { type: 'ID_PROOF', filename: '../../etc/passwd.jpg' }).expect(201);
      expect(res.body.data).toMatchObject({ doc_type: 'ID_PROOF', status: 'UPLOADED', content_type: 'image/jpeg', size_bytes: jpeg().length, provider_id: providerId });
      expect(res.body.data.original_name).toBe('passwd.jpg'); // the path part is dropped
      expect(JSON.stringify(res.body)).not.toMatch(/storage_key|sha256|provider-documents/);
      expect(objectCount()).toBe(1);

      const list = await t.http.get(`/api/v1/providers/${providerId}/documents`).set(as(owner)).expect(200);
      expect(list.body.data).toHaveLength(1);
    });

    it('serves the file back as a DOWNLOAD only: attachment, no sniffing, not cacheable', async () => {
      const id = (await t.http.get(`/api/v1/providers/${providerId}/documents`).set(as(owner))).body.data[0].id;
      const res = await t.http.get(`/api/v1/providers/${providerId}/documents/${id}/file`).set(as(owner)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['content-disposition']).toBe('attachment; filename="id_proof.jpg"');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect((res.body as Buffer).equals(jpeg())).toBe(true);
    });

    it('accepts PNG and PDF too', async () => {
      await upload(owner, providerId, png(), { type: 'ADDRESS_PROOF', filename: 'a.png', mime: 'image/png' }).expect(201);
      await upload(owner, providerId, pdf(), { type: 'TAX_REGISTRATION', filename: 'gst.pdf', mime: 'application/pdf' }).expect(201);
    });

    it.each([
      ['no file', null, 'ID_PROOF', 'image/jpeg', /Attach a file/],
      ['a text file', Buffer.from('hello world'), 'ID_PROOF', 'text/plain', /Unsupported file type/],
      ['an executable renamed to .jpg', Buffer.from('MZ\x90\x00' + 'x'.repeat(100)), 'ID_PROOF', 'image/jpeg', /Unsupported file type/],
      ['PNG bytes claiming to be JPEG', png(), 'ID_PROOF', 'image/jpeg', /does not match its declared type/],
      ['a file over the configured limit', jpeg(25_000), 'ID_PROOF', 'image/jpeg', /too large/],
      ['the antivirus test file inside a PDF', Buffer.concat([pdf(), Buffer.from(EICAR)]), 'ID_PROOF', 'application/pdf', /malware/],
      ['a PDF with a script', pdf('/JavaScript (app.alert(1))'), 'ID_PROOF', 'application/pdf', /scripts or embedded content/],
      ['an unknown document type', jpeg(), 'SELFIE', 'image/jpeg', /doc_type must be one of/],
      ['a missing document type', jpeg(), undefined, 'image/jpeg', /doc_type must be one of/],
    ])('refuses %s with a clear message and stores nothing', async (_name, file, type, mime, message) => {
      const before = objectCount();
      const res = await upload(owner, providerId, file, { type, mime });
      expect(res.status).toBe(422);
      expect(res.body.detail).toMatch(message as RegExp);
      expect(objectCount()).toBe(before);
    });
  });

  describe('access control', () => {
    it('is private to the business: outsiders, customers, anonymous callers and even administrators on the business route are refused', async () => {
      const outsider = await t.login('9400000002');
      const otherId = (await t.http.post('/api/v1/providers').set(as(outsider)).send({ display_name: 'Other' }).expect(201)).body.data.id;
      const docId = (await t.http.get(`/api/v1/providers/${providerId}/documents`).set(as(owner))).body.data[0].id;

      expect([403, 404]).toContain((await upload(outsider, providerId, jpeg(), { type: 'ID_PROOF' })).status);
      expect([403, 404]).toContain((await t.http.get(`/api/v1/providers/${providerId}/documents`).set(as(outsider))).status);
      expect([403, 404]).toContain((await t.http.get(`/api/v1/providers/${providerId}/documents/${docId}/file`).set(as(outsider))).status);
      // Another business's id in the path cannot be used to reach this business's document either.
      expect((await t.http.get(`/api/v1/providers/${otherId}/documents/${docId}/file`).set(as(outsider))).status).toBe(404);
      await upload(null, providerId, jpeg(), { type: 'ID_PROOF' }).expect(401);
      await t.http.get(`/api/v1/providers/${providerId}/documents`).expect(401);
      expect([403, 404]).toContain((await t.http.get(`/api/v1/providers/${providerId}/documents`).set(as(admin))).status); // admins use the admin route
    });
  });

  describe('administrators review', () => {
    it('list, open (audited), verify; reject needs a reason; a decision is final; support operators cannot decide', async () => {
      const docs = (await t.http.get(`/api/v1/admin/providers/${providerId}/documents`).set(as(admin)).expect(200)).body.data as { id: string; doc_type: string }[];
      expect(docs).toHaveLength(3);
      const id = docs.find((d) => d.doc_type === 'ID_PROOF')!.id;
      const tax = docs.find((d) => d.doc_type === 'TAX_REGISTRATION')!.id;

      await t.http.get(`/api/v1/admin/documents/${id}/file`).set(as(admin)).expect(200);
      const viewed = await t.pool.query(`SELECT actor_id FROM audit.audit_logs WHERE action = 'provider.document_viewed' AND entity_id = $1`, [id]);
      expect(viewed.rows).toEqual([{ actor_id: admin.userId }]);

      const verified = await t.http.post(`/api/v1/admin/documents/${id}/verify`).set(as(admin)).send({}).expect(200);
      expect(verified.body.data).toMatchObject({ status: 'VERIFIED' });
      await t.http.post(`/api/v1/admin/documents/${id}/reject`).set(as(admin)).send({ note: 'changed my mind' }).expect(409);

      await t.http.post(`/api/v1/admin/documents/${tax}/reject`).set(as(admin)).send({}).expect(422);
      const rejected = await t.http.post(`/api/v1/admin/documents/${tax}/reject`).set(as(admin)).send({ note: 'The GST number is cut off' }).expect(200);
      expect(rejected.body.data).toMatchObject({ status: 'REJECTED', review_note: 'The GST number is cut off' });

      const fresh = await t.reloginAdmin(support);
      await t.http.get(`/api/v1/admin/providers/${providerId}/documents`).set(as(fresh)).expect(403);
      await t.http.post(`/api/v1/admin/documents/${id}/verify`).set(as(fresh)).send({}).expect(403);
      const mine = (await t.http.get(`/api/v1/providers/${providerId}/documents`).set(as(owner))).body.data;
      expect(mine.find((d: { id: string }) => d.id === tax)).toMatchObject({ status: 'REJECTED', review_note: 'The GST number is cut off' }); // the owner sees why
    });
  });

  describe('deleting', () => {
    it('a pending or rejected document can be deleted (and its file is removed); a verified one cannot', async () => {
      const docs = (await t.http.get(`/api/v1/providers/${providerId}/documents`).set(as(owner))).body.data as { id: string; status: string }[];
      const verified = docs.find((d) => d.status === 'VERIFIED')!;
      const rejected = docs.find((d) => d.status === 'REJECTED')!;
      await t.http.delete(`/api/v1/providers/${providerId}/documents/${verified.id}`).set(as(owner)).expect(409);

      const before = objectCount();
      await t.http.delete(`/api/v1/providers/${providerId}/documents/${rejected.id}`).set(as(owner)).expect(204);
      expect(objectCount()).toBe(before - 1);
      expect((await t.http.get(`/api/v1/providers/${providerId}/documents`).set(as(owner))).body.data.map((d: { id: string }) => d.id)).not.toContain(rejected.id);
      await t.http.get(`/api/v1/providers/${providerId}/documents/${rejected.id}/file`).set(as(owner)).expect(404);
    });

    it('a business can keep at most 20 documents', async () => {
      const p = await t.login('9400000003');
      const pid = (await t.http.post('/api/v1/providers').set(as(p)).send({ display_name: 'Many Docs' }).expect(201)).body.data.id;
      for (let i = 0; i < 20; i++) await upload(p, pid, jpeg(300, i), { type: 'OTHER' }).expect(201);
      const res = await upload(p, pid, jpeg(), { type: 'OTHER' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TOO_MANY_DOCUMENTS');
      expect(objectCount()).toBeGreaterThan(0);
      const files = objectCount();
      await upload(p, pid, jpeg(), { type: 'OTHER' }).expect(409);
      expect(objectCount()).toBe(files); // the refused upload left no orphan behind
    });
  });

  describe('the submission rule', () => {
    it('can require a document before a business is submitted for review (a setting, off by default)', async () => {
      const p = await t.login('9400000004');
      const pid = (await t.http.post('/api/v1/providers').set(as(p)).send({ display_name: 'Rule Salon' }).expect(201)).body.data.id;
      await t.http.post(`/api/v1/providers/${pid}/locations`).set(as(p)).send({ name: 'Main', address_line1: '1 Rd', city: 'Pune', state: 'MH', postal_code: '411001', latitude: 18.5, longitude: 73.8 }).expect(201);

      const a = await t.reloginAdmin(admin);
      await t.http.put('/api/v1/admin/settings/providers.documents_required').set(as(a)).send({ value: true }).expect(200);
      const blocked = await t.http.post(`/api/v1/providers/${pid}/submit`).set(as(p)).expect(409);
      expect(blocked.body.code).toBe('PROVIDER_INCOMPLETE');
      expect(blocked.body.errors).toMatchObject({ missing: ['document'] });

      await upload(p, pid, pdf(), { type: 'BUSINESS_REGISTRATION', mime: 'application/pdf', filename: 'reg.pdf' }).expect(201);
      expect((await t.http.post(`/api/v1/providers/${pid}/submit`).set(as(p))).status).toBe(200);

      const a2 = await t.reloginAdmin(admin);
      await t.http.put('/api/v1/admin/settings/providers.documents_required').set(as(a2)).send({ value: false }).expect(200);
    });
  });
});
