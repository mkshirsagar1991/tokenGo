import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Arrival verification (requirements §18). Neither artefact contains personal data:
 *  - PIN: 6 digits DERIVED from the booking id with a server secret — stable (the customer can re-open it),
 *    needs no storage, and is useless without the id. Brute force is bounded by attempt counting + lockout.
 *  - QR token: `v1.<bookingId>.<expiryEpoch>.<hmac>` — short-lived, signed, opaque to the scanner.
 */
export const QR_TTL_SECONDS = 300;

export function derivePin(secret: Buffer, bookingId: string): string {
  const mac = createHmac('sha256', secret).update(`pin:${bookingId}`).digest();
  return (mac.readUInt32BE(0) % 1_000_000).toString().padStart(6, '0');
}

export function pinMatches(secret: Buffer, bookingId: string, candidate: string): boolean {
  if (!/^\d{6}$/.test(candidate)) return false;
  const expected = Buffer.from(derivePin(secret, bookingId));
  const given = Buffer.from(candidate);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sign(secret: Buffer, bookingId: string, expiry: number): string {
  return createHmac('sha256', secret).update(`qr:${bookingId}:${expiry}`).digest('base64url');
}

export function issueQrToken(secret: Buffer, bookingId: string, nowMs: number): { token: string; expiresAt: Date } {
  const expiry = Math.floor(nowMs / 1000) + QR_TTL_SECONDS;
  return { token: `v1.${bookingId}.${expiry}.${sign(secret, bookingId, expiry)}`, expiresAt: new Date(expiry * 1000) };
}

/** Returns the booking id the token is for, or null if it is malformed, forged or expired. */
export function verifyQrToken(secret: Buffer, token: string, nowMs: number): string | null {
  const m = /^v1\.([0-9a-f-]{36})\.(\d{9,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const [, bookingId, expiryText, mac] = m as unknown as [string, string, string, string];
  const expiry = Number(expiryText);
  if (expiry * 1000 < nowMs) return null;
  const expected = Buffer.from(sign(secret, bookingId, expiry));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected) ? bookingId : null;
}
