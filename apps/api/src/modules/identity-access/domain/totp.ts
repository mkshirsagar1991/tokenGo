import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) — the interoperable profile every authenticator app
 * supports. Implemented directly (≈40 lines, verified against the RFC test vectors) rather than adding
 * a dependency to the authentication path.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret (RFC 4226 recommended length). */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Returns the matching time-step (so the caller can persist it and refuse replays) or null.
 * Accepts ±1 step (±30 s) for clock drift. `lastAcceptedStep` blocks re-use of the same code.
 */
export function verifyTotp(secret: Buffer, code: string, atMs: number, lastAcceptedStep?: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(atMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(hotp(secret, step));
    // Evaluate every candidate (no early exit) so timing does not reveal which step matched.
    if (timingSafeEqual(given, expected) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (lastAcceptedStep !== undefined && lastAcceptedStep !== null && matched <= lastAcceptedStep) return null;
  return matched;
}

export function otpauthUri(secret: Buffer, accountLabel: string, issuer = 'TokenGo'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
