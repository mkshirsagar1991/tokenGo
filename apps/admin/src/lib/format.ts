/**
 * Display helpers. Every instant from the API is UTC; the portal shows Indian Standard Time with an explicit zone so the
 * server-rendered HTML and the browser agree (no hydration mismatches) and so screenshots/exports are unambiguous.
 */
export const DISPLAY_TZ = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: DISPLAY_TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: DISPLAY_TZ, day: '2-digit', month: 'short', year: 'numeric' });
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  return d ? `${dateTimeFmt.format(d)} IST` : '—';
}

export function formatDate(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  return d ? dateFmt.format(d) : '—';
}

/** "YYYY-MM-DD" for the given instant in IST. */
export function istDateString(v: string | number | Date): string {
  const d = toDate(v);
  return d ? ymdFmt.format(d) : '';
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `datetime-local` value ("2026-10-07T14:30") entered as IST -> ISO-8601 instant. Returns null when it is not a valid value. */
export function istLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const d = new Date(`${local}:00${IST_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO instant -> `datetime-local` value in IST (for pre-filling inputs). */
export function isoToIstLocal(v: string | number | Date): string {
  const d = toDate(v);
  if (!d) return '';
  const shifted = new Date(d.getTime() + 330 * 60_000);
  return shifted.toISOString().slice(0, 16);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A short form of an id for tables. The API's ids are UUIDv7: the first 48 bits are a millisecond timestamp, so everything
 * created within about a minute shares its first 8 characters and a table of them reads as one repeated value. For a UUID
 * show the end of the id (the random part) behind an ellipsis; anything else keeps its first 8 characters. The full id is
 * always available on hover and through the copy button.
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return UUID_RE.test(id) ? `…${id.slice(-8)}` : id.slice(0, 8);
}

export function relativeTime(v: string | number | Date | null | undefined, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d) return '—';
  const diff = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diff);
  const unit = abs < 60 ? [abs, 's'] : abs < 3600 ? [Math.round(abs / 60), 'm'] : abs < 86400 ? [Math.round(abs / 3600), 'h'] : [Math.round(abs / 86400), 'd'];
  return diff >= 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`;
}

/** SNAKE_CASE or kebab -> "Sentence case". */
export function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, ' ').toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
