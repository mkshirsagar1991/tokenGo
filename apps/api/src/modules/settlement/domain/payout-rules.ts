/** Pure rules for bank details, name matching, batching and retry timing. No I/O. */

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^[0-9]{9,18}$/;
const HOLDER_RE = /^[\p{L}][\p{L}\p{M} .'&-]{1,99}$/u;

export const normalizeIfsc = (s: string) => s.trim().toUpperCase();
export const normalizeAccountNumber = (s: string) => s.replace(/[\s-]/g, '');
export const normalizeHolderName = (s: string) => s.trim().replace(/\s+/g, ' ');

export const isValidIfsc = (s: string) => IFSC_RE.test(s);
export const isValidAccountNumber = (s: string) => ACCOUNT_RE.test(s);
export const isValidHolderName = (s: string) => HOLDER_RE.test(s);

/** What a client may ever see of an account number. */
export const maskAccountNumber = (last4: string) => `XXXXXX${last4}`;

const HONORIFICS = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'SHRI', 'SMT', 'SRI', 'M/S', 'MS.']);

const nameTokens = (name: string): Set<string> =>
  new Set(
    name
      .toUpperCase()
      .replace(/['’.]/g, '') // banks write D'Souza as DSOUZA and Pvt. as PVT: these are removed, not word breaks
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !HONORIFICS.has(t)),
  );

/**
 * Does the name registered at the bank belong to the person/business we were told? A bank may register fewer or more words than
 * were typed ("RIYA SHARMA" vs "RIYA KUMARI SHARMA"), but every word of the SHORTER name must appear in the longer. Order, case,
 * punctuation and honorifics are ignored. Two names with nothing in common never match, and an empty name never matches.
 * This is a safety check against paying a stranger, not an identity guarantee.
 */
export function namesMatch(typed: string, atBank: string): boolean {
  const a = nameTokens(typed);
  const b = nameTokens(atBank);
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((t) => large.has(t));
}

export interface BatchCandidate {
  id: string;
  netMinor: bigint;
}

/**
 * Oldest-first packing under a per-payout cap. It stops at the first payable that would exceed the cap (so older money is never
 * leapfrogged), except that a single payable larger than the cap is paid alone rather than stranded forever.
 */
export function pickBatch(candidates: BatchCandidate[], maxMinor: bigint): { ids: string[]; total: bigint } {
  const ids: string[] = [];
  let total = 0n;
  for (const c of candidates) {
    if (ids.length > 0 && total + c.netMinor > maxMinor) break;
    ids.push(c.id);
    total += c.netMinor;
  }
  return { ids, total };
}

/** After n consecutive failures the money waits 1h, 2h, 4h … up to 24h before it is tried in a new payout. */
export const retryDelayHours = (consecutiveFailures: number) => Math.min(2 ** Math.max(0, consecutiveFailures - 1), 24);
