/**
 * Business-timezone arithmetic without a date library (requirements §10: store UTC, schedule in the
 * business timezone). Only `Intl` is used, so IANA rules — including DST and half-hour zones — come from
 * the runtime's tz database.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at the given instant, in minutes (IST = +330). */
export function tzOffsetMinutes(instantMs: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts['year']!, parts['month']! - 1, parts['day']!, parts['hour']!, parts['minute']!, parts['second']!);
  // Drop sub-second part of the instant so the comparison is exact.
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

export function parseLocalDate(iso: string): LocalDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RangeError(`Invalid date "${iso}" (expected YYYY-MM-DD)`);
  const d: LocalDate = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const check = new Date(Date.UTC(d.year, d.month - 1, d.day));
  if (check.getUTCFullYear() !== d.year || check.getUTCMonth() !== d.month - 1 || check.getUTCDate() !== d.day) {
    throw new RangeError(`Invalid calendar date "${iso}"`);
  }
  return d;
}

export function formatLocalDate(d: LocalDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(d: LocalDate): number {
  const w = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay(); // 0 = Sunday
  return w === 0 ? 7 : w;
}

/**
 * The UTC instant at which the wall clock in `tz` reads `minutesOfDay` on local date `d`.
 * Handles DST: for a wall time that does not exist (spring-forward gap) the instant just after the gap is
 * returned; for an ambiguous time (fall-back) the EARLIER occurrence is returned.
 * `minutesOfDay` may be 1440 ("end of day") — it resolves to local midnight of the next day.
 */
export function localToUtcMs(d: LocalDate, minutesOfDay: number, tz: string): number {
  const naive = Date.UTC(d.year, d.month - 1, d.day, 0, minutesOfDay);
  // First guess uses the offset at the naive instant; correct once for the offset at the guess itself.
  let guess = naive - tzOffsetMinutes(naive, tz) * 60_000;
  const second = naive - tzOffsetMinutes(guess, tz) * 60_000;
  if (second !== guess) {
    // Offsets differ across the transition. Prefer the earlier valid instant that maps back to `naive`.
    const candidates = [guess, second].sort((a, b) => a - b);
    const valid = candidates.find((c) => c + tzOffsetMinutes(c, tz) * 60_000 === naive);
    guess = valid ?? Math.max(guess, second); // gap: land just after the missing hour
  }
  return guess;
}

/** The local calendar date + minute-of-day at an instant. */
export function utcToLocal(instantMs: number, tz: string): { date: LocalDate; minuteOfDay: number } {
  const local = new Date(instantMs + tzOffsetMinutes(instantMs, tz) * 60_000);
  return {
    date: { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() },
    minuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

export function parseHHMM(text: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!m) throw new RangeError(`Invalid time "${text}" (expected HH:MM, 00:00-23:59)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** "2026-10-13T09:00" — the wall-clock reading in `tz` at an instant (for customer/provider display). */
export function localDateTime(instantMs: number, tz: string): string {
  const { date, minuteOfDay } = utcToLocal(instantMs, tz);
  return `${formatLocalDate(date)}T${formatHHMM(minuteOfDay)}`;
}
