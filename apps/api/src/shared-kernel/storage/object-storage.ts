import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

/**
 * Where uploaded files (provider documents, dispute evidence) live. The API never links to a stored file: it authorises the
 * request and streams the bytes itself, so an object key can never be guessed into access.
 * Keys look like `provider-documents/<uuid>`; nothing user-controlled is ever part of a key.
 */
export interface ObjectStorage {
  readonly driver: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

const KEY = /^[a-z][a-z0-9-]{1,40}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertValidKey(key: string): void {
  if (!KEY.test(key)) throw new Error('Invalid storage key');
}

/** Development and tests only (production configuration refuses it). Files live under one directory; paths cannot escape it. */
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    assertValidKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.type`, contentType);
  }

  async get(key: string): Promise<StoredObject | null> {
    const file = this.path(key);
    try {
      return { body: await readFile(file), contentType: (await readFile(`${file}.type`, 'utf8')).trim() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.path(key);
    await rm(file, { force: true });
    await rm(`${file}.type`, { force: true });
  }
}

/** Amazon S3 with the task role's credentials (never static keys). The bucket is private; its default encryption applies. */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;

  constructor(
    private readonly bucket: string,
    private readonly client: Pick<S3Client, 'send'>,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<StoredObject | null> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return { body: Buffer.from(await res.Body.transformToByteArray()), contentType: res.ContentType ?? 'application/octet-stream' };
    } catch (e) {
      if (e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
