import {
  LocalDate,
  addDays,
  isoWeekday,
  localToUtcMs,
  parseLocalDate,
  utcToLocal,
  formatLocalDate,
} from './local-time';

/**
 * Pure availability engine (requirements §10). NO I/O, NO clock, NO randomness: everything it needs is
 * passed in, so it is exhaustively unit- and property-testable. Output is ADVISORY — the commit path must
 * still re-check transactionally (the database exclusion constraint is the final arbiter, docs §H.2).
 */

export interface Interval {
  start: number;
  end: number; // exclusive
}

/** Weekly recurring rule in LOCAL wall-clock minutes-of-day (0..1440). weekday: ISO 1=Mon..7=Sun. */
export interface WeeklyRule {
  kind: 'WORKING' | 'BREAK';
  weekday: number;
  startMin: number;
  endMin: number;
}

/** A dated override. CLOSED removes time (holiday/leave); OPEN adds working time (special opening). */
export interface DateException {
  kind: 'CLOSED' | 'OPEN';
  startDate: string; // inclusive, local YYYY-MM-DD
  endDate: string; // inclusive
  startMin: number | null; // null => whole day
  endMin: number | null;
}

export interface Schedule {
  rules: WeeklyRule[];
  exceptions: DateException[];
}

export interface ResourceSchedule extends Schedule {
  resourceId: string;
  /** Existing reservations/blocks as UTC ms intervals. Buffers are already included in them. */
  busy: Interval[];
}

export interface SlotQuery {
  timezone: string;
  fromDate: string; // local date of the first day to evaluate
  days: number;
  durationMin: number;
  bufferMin: number;
  granularityMin: number;
  nowMs: number;
  minLeadMin: number;
  maxAdvanceDays: number;
  location: Schedule;
  resources: ResourceSchedule[];
}

export interface Slot {
  startMs: number;
  /** Customer-visible end (start + duration). The buffer after it is held for the provider. */
  endMs: number;
  resourceIds: string[];
}

const MS = 60_000;
const DAY_MIN = 1440;

// ---------------------------------------------------------------- interval algebra (integers) ----------

export function normalize(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

export function subtract(from: Interval[], remove: Interval[]): Interval[] {
  let result = normalize(from);
  for (const r of normalize(remove)) {
    const next: Interval[] = [];
    for (const i of result) {
      if (r.end <= i.start || r.start >= i.end) next.push(i);
      else {
        if (r.start > i.start) next.push({ start: i.start, end: r.start });
        if (r.end < i.end) next.push({ start: r.end, end: i.end });
      }
    }
    result = next;
  }
  return result;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const lo = Math.max(x[i]!.start, y[j]!.start);
    const hi = Math.min(x[i]!.end, y[j]!.end);
    if (hi > lo) out.push({ start: lo, end: hi });
    if (x[i]!.end < y[j]!.end) i++;
    else j++;
  }
  return out;
}

// ---------------------------------------------------------------- one local day ----------------------------

function exceptionCovers(e: DateException, date: string): boolean {
  return date >= e.startDate && date <= e.endDate; // ISO dates compare lexicographically
}

function exceptionMinutes(e: DateException): Interval {
  return { start: e.startMin ?? 0, end: e.endMin ?? DAY_MIN };
}

/**
 * Working time (local minutes) of one schedule on one date:
 *   (WORKING rules for the weekday ∪ OPEN exceptions) − BREAK rules − CLOSED exceptions.
 */
export function workingMinutes(schedule: Schedule, date: LocalDate): Interval[] {
  const iso = formatLocalDate(date);
  const weekday = isoWeekday(date);
  const working = schedule.rules.filter((r) => r.kind === 'WORKING' && r.weekday === weekday).map((r) => ({ start: r.startMin, end: r.endMin }));
  const opens = schedule.exceptions.filter((e) => e.kind === 'OPEN' && exceptionCovers(e, iso)).map(exceptionMinutes);
  const breaks = schedule.rules.filter((r) => r.kind === 'BREAK' && r.weekday === weekday).map((r) => ({ start: r.startMin, end: r.endMin }));
  const closed = schedule.exceptions.filter((e) => e.kind === 'CLOSED' && exceptionCovers(e, iso)).map(exceptionMinutes);
  return subtract(normalize([...working, ...opens]), [...breaks, ...closed]);
}

/**
 * A resource with NO working rules of its own follows the location's hours (an owner-managed chair).
 * A resource with its own rules is bounded by BOTH its schedule and the location's opening hours.
 */
export function resourceMinutes(location: Schedule, resource: Schedule, date: LocalDate): Interval[] {
  const loc = workingMinutes(location, date);
  const hasOwnRules = resource.rules.some((r) => r.kind === 'WORKING') || resource.exceptions.some((e) => e.kind === 'OPEN');
  if (!hasOwnRules) {
    // Own CLOSED/BREAK entries (leave, lunch) still apply on top of the location hours.
    const own = resource.rules.filter((r) => r.kind === 'BREAK' && r.weekday === isoWeekday(date)).map((r) => ({ start: r.startMin, end: r.endMin }));
    const iso = formatLocalDate(date);
    const closed = resource.exceptions.filter((e) => e.kind === 'CLOSED' && exceptionCovers(e, iso)).map(exceptionMinutes);
    return subtract(loc, [...own, ...closed]);
  }
  return intersect(loc, workingMinutes(resource, date));
}

// ---------------------------------------------------------------- the engine ---------------------------------

export function occupiedInterval(startMs: number, durationMin: number, bufferMin: number): Interval {
  return { start: startMs, end: startMs + (durationMin + bufferMin) * MS };
}

export function computeSlots(q: SlotQuery): Slot[] {
  if (q.durationMin <= 0 || q.granularityMin <= 0 || q.bufferMin < 0 || q.days <= 0) return [];
  const needMs = (q.durationMin + q.bufferMin) * MS;
  const earliest = q.nowMs + q.minLeadMin * MS;
  const latest = q.nowMs + q.maxAdvanceDays * 86_400_000;
  const first = parseLocalDate(q.fromDate);

  const byStart = new Map<number, Set<string>>();

  for (let d = 0; d < q.days; d++) {
    const date = addDays(first, d);
    for (const res of q.resources) {
      const minutes = resourceMinutes(q.location, res, date);
      // local minutes -> UTC intervals, then remove what is already reserved
      const utc = minutes.map((m) => ({
        start: localToUtcMs(date, m.start, q.timezone),
        end: localToUtcMs(date, m.end, q.timezone),
      }));
      for (const free of subtract(utc, res.busy)) {
        for (
          let s = firstAlignedAtOrAfter(free.start, q.granularityMin, q.timezone);
          s + needMs <= free.end;
          s = nextAligned(s, q.granularityMin, q.timezone)
        ) {
          if (s < earliest || s > latest) continue;
          let set = byStart.get(s);
          if (!set) byStart.set(s, (set = new Set()));
          set.add(res.resourceId);
        }
      }
    }
  }

  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startMs, ids]) => ({ startMs, endMs: startMs + q.durationMin * MS, resourceIds: [...ids].sort() }));
}

/**
 * "Aligned" is defined on INSTANTS: the local wall-clock minute-of-day in `tz` is a multiple of the
 * granularity. Defining it this way (rather than converting wall-clock times back to UTC) is what makes
 * DST correct: a wall time that does not exist (spring-forward gap) is never produced, and a wall time that
 * happens twice (fall-back) is produced twice.
 */
function isAligned(instantMs: number, granularityMin: number, tz: string): boolean {
  return utcToLocal(instantMs, tz).minuteOfDay % granularityMin === 0;
}

/** Longest DST discontinuity we scan across minute-by-minute (real-world shifts are 30 or 60 minutes). */
const MAX_SCAN_MIN = 3 * 60;

/** First aligned instant >= `fromMs`. */
function firstAlignedAtOrAfter(fromMs: number, granularityMin: number, tz: string): number {
  let s = Math.ceil(fromMs / MS) * MS; // whole minutes only
  for (let i = 0; i <= MAX_SCAN_MIN + granularityMin; i++, s += MS) {
    if (isAligned(s, granularityMin, tz)) return s;
  }
  return Number.POSITIVE_INFINITY; // unreachable for real zones; yields no slots rather than looping
}

/**
 * The next aligned instant strictly after an aligned `prevMs`. Normally exactly one granularity later;
 * if a DST shift that is not a multiple of the granularity lands inside the stride (Lord Howe's 30-minute
 * shift with an hourly grid) the stride is off-grid, so scan minute-by-minute for the next aligned instant.
 */
function nextAligned(prevMs: number, granularityMin: number, tz: string): number {
  const stride = prevMs + granularityMin * MS;
  if (isAligned(stride, granularityMin, tz)) return stride;
  let s = prevMs + MS;
  for (let i = 0; i <= MAX_SCAN_MIN + granularityMin; i++, s += MS) {
    if (isAligned(s, granularityMin, tz)) return s;
  }
  return Number.POSITIVE_INFINITY;
}

/** Is the location open (per its own rules/exceptions) at this instant? Used for the "open now" badge. */
export function isOpenAt(location: Schedule, tz: string, instantMs: number): boolean {
  const { date, minuteOfDay } = utcToLocal(instantMs, tz);
  return workingMinutes(location, date).some((i) => minuteOfDay >= i.start && minuteOfDay < i.end);
}
