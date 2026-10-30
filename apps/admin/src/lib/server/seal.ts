import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for cookie values (AES-256-GCM). The browser holds an opaque blob it can neither read nor alter:
 * tampering, truncation, a wrong key, or moving a blob to another cookie (the cookie name is bound in as AAD) all fail to open.
 * Format: "v1." + base64url(iv[12] | tag[16] | ciphertext).
 */
const VERSION = 'v1.';

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'tokengo-admin-salt', 'tokengo-admin-cookie-v1', 32));
}

export function seal(payload: unknown, secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function unseal<T>(value: string | undefined | null, secret: string, purpose: string): T | null {
  if (!value || !value.startsWith(VERSION)) return null;
  try {
    const raw = Buffer.from(value.slice(VERSION.length), 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(12, 28));
    const pt = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  } catch {
    return null;
  }
}
