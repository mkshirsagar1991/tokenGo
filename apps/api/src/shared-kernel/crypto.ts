import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const FORMAT_VERSION = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * AES-256-GCM field-level encryption for high-sensitivity values (docs §M.1).
 * Layout: version(1) | iv(12) | auth tag(16) | ciphertext. The version byte allows key/algorithm rotation.
 * In production the key is supplied from AWS Secrets Manager / KMS-derived data keys.
 */
export class FieldCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('FieldCipher requires a 32-byte key');
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(payload: Buffer): string {
    if (payload.length < 1 + IV_LENGTH + TAG_LENGTH || payload[0] !== FORMAT_VERSION) {
      throw new Error('Unsupported or corrupt ciphertext');
    }
    const iv = payload.subarray(1, 1 + IV_LENGTH);
    const tag = payload.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
    const body = payload.subarray(1 + IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}

/** Keyed hash used as a deterministic blind index (e.g. phone lookup) and for OTP/PIN storage. */
export function hmacSha256Hex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** Unkeyed hash for high-entropy opaque tokens (refresh tokens) — never use for low-entropy secrets. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** URL-safe random token with `bytes` of entropy (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
