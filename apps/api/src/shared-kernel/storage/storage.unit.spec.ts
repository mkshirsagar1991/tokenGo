import { NoSuchKey } from '@aws-sdk/client-s3';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationFailedError } from '../errors';
import { LocalObjectStorage, S3ObjectStorage, assertValidKey } from './object-storage';
import { checkUpload, inspectContent, sniffType } from './upload-validation';

const KEY = 'provider-documents/01a115c7-bb51-75c3-961d-e6e3b9405489';
const jpeg = (n = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
const pdf = (extra = '') => Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\n%%EOF`);

describe('object keys', () => {
  it('accept only <prefix>/<uuid>, so nothing user-controlled is ever part of a path', () => {
    expect(() => assertValidKey(KEY)).not.toThrow();
    for (const bad of ['../etc/passwd', 'provider-documents/../../x', 'provider-documents/not-a-uuid', '/provider-documents/' + KEY.split('/')[1], 'PROVIDER/' + KEY.split('/')[1], 'provider-documents/' + KEY.split('/')[1] + '/x', '']) {
      expect(() => assertValidKey(bad)).toThrow(/Invalid storage key/);
    }
  });
});

describe('LocalObjectStorage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokengo-storage-'));
  const storage = new LocalObjectStorage(dir);

  it('round-trips bytes and content type, returns null for a missing object, and deletes', async () => {
    await storage.put(KEY, jpeg(), 'image/jpeg');
    const got = await storage.get(KEY);
    expect(got?.contentType).toBe('image/jpeg');
    expect(got?.body.equals(jpeg())).toBe(true);
    await storage.delete(KEY);
    expect(await storage.get(KEY)).toBeNull();
    expect(readdirSync(join(dir, 'provider-documents'))).toEqual([]);
  });

  it('refuses a key that could escape its directory', async () => {
    await expect(storage.put('../../outside', jpeg(), 'image/jpeg')).rejects.toThrow(/Invalid storage key/);
    await expect(storage.get('provider-documents/../../outside')).rejects.toThrow(/Invalid storage key/);
  });
});

describe('S3ObjectStorage (against a stand-in client)', () => {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  let behaviour: 'ok' | 'missing' | 'error' = 'ok';
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'GetObjectCommand') {
        if (behaviour === 'missing') throw new NoSuchKey({ message: 'missing', $metadata: {} });
        if (behaviour === 'error') throw new Error('S3 is down');
        return { Body: { transformToByteArray: async () => new Uint8Array(jpeg()) }, ContentType: 'image/jpeg' };
      }
      return {};
    },
  };
  const s3 = new S3ObjectStorage('tokengo-docs', client as never);

  it('writes to the configured private bucket and reads back, without any public ACL', async () => {
    await s3.put(KEY, jpeg(), 'image/jpeg');
    expect(sent[0]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'tokengo-docs', Key: KEY, ContentType: 'image/jpeg' } });
    expect(sent[0]!.input).not.toHaveProperty('ACL');
    expect((await s3.get(KEY))?.body.equals(jpeg())).toBe(true);
    await s3.delete(KEY);
    expect(sent.map((c) => c.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
  });

  it('maps "no such object" to null but lets a real failure surface (it must not look like a missing file)', async () => {
    behaviour = 'missing';
    expect(await s3.get(KEY)).toBeNull();
    behaviour = 'error';
    await expect(s3.get(KEY)).rejects.toThrow('S3 is down');
  });

  it('validates keys before talking to S3', async () => {
    await expect(s3.put('nope', jpeg(), 'image/jpeg')).rejects.toThrow(/Invalid storage key/);
  });
});

describe('upload validation', () => {
  const allowed = ['image/jpeg', 'image/png', 'application/pdf'] as const;
  const opts = { allowed, maxBytes: 5_000_000 };

  it('identifies files by their bytes, never by their name or claimed type', () => {
    expect(sniffType(jpeg())).toBe('image/jpeg');
    expect(sniffType(png())).toBe('image/png');
    expect(sniffType(pdf())).toBe('application/pdf');
    expect(sniffType(Buffer.from('plain text'))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });

  it('accepts a genuine file, reporting its true type, size and a content hash', () => {
    const ok = checkUpload({ buffer: jpeg(), mimetype: 'image/jpeg' }, opts);
    expect(ok).toMatchObject({ type: 'image/jpeg', size: jpeg().length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(checkUpload({ buffer: pdf(), mimetype: undefined }, opts).type).toBe('application/pdf');
  });

  it.each([
    [undefined, /Attach a file/],
    [{ buffer: Buffer.alloc(0) }, /Attach a file/],
    [{ buffer: Buffer.from('MZ' + 'x'.repeat(50)), mimetype: 'application/pdf' }, /Unsupported file type/],
    [{ buffer: Buffer.from('#!/bin/sh\nrm -rf /'), mimetype: 'image/png' }, /Unsupported file type/],
    [{ buffer: png(), mimetype: 'image/jpeg' }, /does not match its declared type/],
    [{ buffer: jpeg(6_000_000), mimetype: 'image/jpeg' }, /too large \(the limit is 5 MB\)/],
  ])('refuses %#', (file, message) => {
    expect(() => checkUpload(file as never, opts)).toThrow(message as RegExp);
    expect(() => checkUpload(file as never, opts)).toThrow(ValidationFailedError);
  });

  it('refuses the antivirus test file and PDFs carrying active content, but accepts a clean PDF', () => {
    const eicar = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    expect(inspectContent(eicar, 'application/pdf')).toMatch(/malware/);
    for (const active of ['/JavaScript', '/JS', '/OpenAction', '/Launch', '/EmbeddedFile']) expect(inspectContent(pdf(active), 'application/pdf')).toMatch(/scripts or embedded content/);
    expect(inspectContent(pdf(), 'application/pdf')).toBeNull();
    // A JPEG may contain the letters "JS" — only PDFs are inspected for active content.
    expect(inspectContent(Buffer.concat([jpeg(), Buffer.from('/JS')]), 'image/jpeg')).toBeNull();
  });
});
