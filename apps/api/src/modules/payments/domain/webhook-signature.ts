import { createHmac, timingSafeEqual } from 'node:crypto';

/** Webhooks older (or newer) than this are refused, which bounds the replay window of a captured request. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * `t=<unix seconds>,v1=<hex hmac-sha256>` where the MAC covers `"<t>." + rawBody`. Signing the timestamp
 * means an attacker cannot replay an old genuine request with a fresh timestamp.
 */
export function signWebhook(secret: Buffer, timestampSeconds: number, rawBody: Buffer): string {
  return `t=${timestampSeconds},v1=${mac(secret, timestampSeconds, rawBody)}`;
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: 'MISSING' | 'MALFORMED' | 'MISMATCH' | 'STALE' };

/**
 * Verifies over the RAW bytes (re-serialising parsed JSON would change them). Constant-time comparison.
 * Several `v1=` values are accepted so a signing secret can be rotated without dropping events.
 * `nowMs` is injected (never read from the system clock here) so the tolerance is deterministic in tests.
 */
export function verifyWebhookSignature(
  secrets: Buffer | Buffer[],
  header: string | undefined,
  rawBody: Buffer,
  nowMs: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): SignatureVerdict {
  if (!header) return { ok: false, reason: 'MISSING' };

  let timestamp: number | undefined;
  const candidates: Buffer[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) return { ok: false, reason: 'MALFORMED' };
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) candidates.push(Buffer.from(value, 'hex'));
  }
  if (timestamp === undefined || candidates.length === 0) return { ok: false, reason: 'MALFORMED' };

  // Check the MAC BEFORE the clock so the two failure modes cannot be told apart by timing.
  const secretList = Array.isArray(secrets) ? secrets : [secrets];
  let authentic = false;
  for (const secret of secretList) {
    const expected = Buffer.from(mac(secret, timestamp, rawBody), 'hex');
    for (const candidate of candidates) {
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) authentic = true;
    }
  }
  if (!authentic) return { ok: false, reason: 'MISMATCH' };
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return { ok: false, reason: 'STALE' };
  return { ok: true };
}

function mac(secret: Buffer, timestampSeconds: number, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
}
