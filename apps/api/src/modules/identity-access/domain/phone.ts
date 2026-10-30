/**
 * Phone normalisation to E.164. v1 launch market is India (+91, docs assumption S1); the function is
 * deliberately country-aware so adding markets is a data change, not a rewrite.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(input: string, defaultCountryCode = '91'): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 20) return null;

  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/[\s\-().]/g, '');
  if (hasPlus) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;

  let e164: string;
  if (hasPlus) {
    e164 = `+${digits}`;
  } else if (defaultCountryCode === '91') {
    // India: accept 10-digit national numbers, optional leading 0, or 91-prefixed 12-digit numbers.
    const national = digits.startsWith('0') ? digits.slice(1) : digits;
    if (national.length === 10) e164 = `+91${national}`;
    else if (national.length === 12 && national.startsWith('91')) e164 = `+${national}`;
    else return null;
  } else {
    e164 = `+${defaultCountryCode}${digits.replace(/^0+/, '')}`;
  }

  if (!E164.test(e164)) return null;
  // Indian mobile numbers start with 6-9 (rejects landlines / obviously invalid input).
  if (e164.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(e164)) return null;
  return e164;
}

/** `+91 ••••• ••123` — the only form of a phone number that may appear in logs, support views, or audit metadata. */
export function maskPhone(e164: string): string {
  const last = e164.slice(-3);
  return `${e164.slice(0, 3)} ••••• ••${last}`;
}
