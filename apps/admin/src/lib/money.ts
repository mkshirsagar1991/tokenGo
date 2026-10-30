/**
 * Money is integer minor units (paise) everywhere. Nothing in here uses floating point: amounts are parsed and
 * formatted with BigInt arithmetic and string manipulation only.
 */
export interface MoneyJson {
  amount_minor: number;
  currency: string;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toBig(minor: bigint | number | string): bigint {
  if (typeof minor === 'bigint') return minor;
  if (typeof minor === 'number') {
    if (!Number.isSafeInteger(minor)) throw new RangeError('Money amounts must be safe integers of minor units');
    return BigInt(minor);
  }
  if (!/^-?\d+$/.test(minor)) throw new RangeError('Money amounts must be integer strings');
  return BigInt(minor);
}

/** Indian digit grouping: 12500000 -> "1,25,00,000". Input is a non-negative digit string. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

export interface FormatOptions {
  /** 'auto' (default) shows paise only when they are not zero; 'always' always shows two decimals. */
  fraction?: 'auto' | 'always';
  /** Prefix the amount with the currency symbol (default true). */
  symbol?: boolean;
}

/** Formats integer paise as rupees with Indian grouping: 12500000 -> "₹1,25,000"; 12500050 -> "₹1,25,000.50". */
export function formatInr(minor: bigint | number | string, opts: FormatOptions = {}): string {
  const v = toBig(minor);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const rupees = (abs / 100n).toString();
  const paise = Number(abs % 100n);
  const fraction = opts.fraction === 'always' || paise !== 0 ? `.${String(paise).padStart(2, '0')}` : '';
  const symbol = opts.symbol === false ? '' : '₹';
  return `${negative ? '-' : ''}${symbol}${groupIndian(rupees)}${fraction}`;
}

/** Formats an API money object. INR uses Indian grouping; any other currency is shown as "USD 1,234.50" (2 minor digits assumed). */
export function formatMoney(m: MoneyJson | null | undefined, opts: FormatOptions = {}): string {
  if (!m) return '—';
  if (m.currency === 'INR') return formatInr(m.amount_minor, opts);
  const v = toBig(m.amount_minor);
  const abs = v < 0n ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0n ? '-' : ''}${m.currency} ${whole}.${String(Number(abs % 100n)).padStart(2, '0')}`;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parses what a person types as a rupee amount ("1250", "1,250.5", "₹ 99.99") into integer paise.
 * Rejects negatives, more than two decimals, exponents and anything that is not plainly a decimal number.
 */
export function parseRupeesToMinor(input: string, opts: { allowZero?: boolean } = {}): ParseResult<number> {
  const cleaned = input.replace(/[₹\s]/g, '').replace(/,/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter an amount.' };
  if (cleaned.startsWith('-')) return { ok: false, error: 'The amount cannot be negative.' };
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return { ok: false, error: /\.\d{3,}/.test(cleaned) ? 'Use at most two decimal places (paise).' : 'Enter a plain number such as 1250 or 1250.50.' };
  const minor = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  if (minor > MAX_SAFE) return { ok: false, error: 'That amount is too large.' };
  if (minor === 0n && !opts.allowZero) return { ok: false, error: 'The amount must be greater than zero.' };
  return { ok: true, value: Number(minor) };
}

/** Basis points as a percentage string: 1000 -> "10%", 1250 -> "12.5%", 1 -> "0.01%". */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError('Basis points must be a non-negative integer');
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%`;
}

/** Parses "12.5" (percent, at most two decimals, 0–100) into basis points (1250). */
export function parsePercentToBps(input: string, opts: { min?: number; max?: number } = {}): ParseResult<number> {
  const cleaned = input.replace(/[%\s]/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter a percentage.' };
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return { ok: false, error: 'Enter a percentage such as 10 or 12.5 (at most two decimals).' };
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  const min = opts.min ?? 0;
  const max = opts.max ?? 10000;
  if (bps < min || bps > max) return { ok: false, error: `Must be between ${formatBps(min)} and ${formatBps(max)}.` };
  return { ok: true, value: bps };
}

/** Sum of integer minor units without ever leaving BigInt. */
export function sumMinor(values: Array<number | bigint | string>): bigint {
  return values.reduce<bigint>((acc, v) => acc + toBig(v), 0n);
}
