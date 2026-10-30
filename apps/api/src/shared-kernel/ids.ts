import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp + random bits. Time-ordered, so primary-key
 * B-tree inserts stay append-mostly (docs §G.1). Monotonic within the same millisecond.
 */
let lastMs = -1;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  let ms = now;
  if (ms <= lastMs) {
    // Same (or earlier, on clock skew) millisecond: keep ordering by bumping a 12-bit counter.
    ms = lastMs;
    counter = (counter + 1) & 0xfff;
    if (counter === 0) ms = ++lastMs;
  } else {
    lastMs = ms;
    counter = bytes.readUInt16BE(6) & 0x0fff;
  }

  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + counter high bits
  bytes[7] = counter & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
