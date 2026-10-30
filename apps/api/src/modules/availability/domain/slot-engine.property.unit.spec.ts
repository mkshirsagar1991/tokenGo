import * as fc from 'fast-check';
import { LocalDate, addDays, formatLocalDate, isoWeekday, localToUtcMs, parseLocalDate, utcToLocal } from './local-time';
import { DateException, Interval, ResourceSchedule, Schedule, SlotQuery, WeeklyRule, computeSlots } from './slot-engine';

const MIN = 60_000;

/**
 * INDEPENDENT ORACLE. It shares none of the engine's interval algebra: for every single minute it asks
 * "is this resource working, and not busy, right now?" straight from the rules. The engine must agree with
 * it EXACTLY — no offered slot may be infeasible (soundness) and no feasible slot may be missed (completeness).
 */
function covers(e: DateException, date: string): boolean {
  return date >= e.startDate && date <= e.endDate;
}
function inWindow(e: DateException, minute: number): boolean {
  return minute >= (e.startMin ?? 0) && minute < (e.endMin ?? 1440);
}
function scheduleWorks(s: Schedule, date: LocalDate, minute: number): boolean {
  const iso = formatLocalDate(date);
  const wd = isoWeekday(date);
  const working =
    s.rules.some((r) => r.kind === 'WORKING' && r.weekday === wd && minute >= r.startMin && minute < r.endMin) ||
    s.exceptions.some((e) => e.kind === 'OPEN' && covers(e, iso) && inWindow(e, minute));
  const onBreak = s.rules.some((r) => r.kind === 'BREAK' && r.weekday === wd && minute >= r.startMin && minute < r.endMin);
  const closed = s.exceptions.some((e) => e.kind === 'CLOSED' && covers(e, iso) && inWindow(e, minute));
  return working && !onBreak && !closed;
}
function resourceWorks(loc: Schedule, res: Schedule, date: LocalDate, minute: number): boolean {
  const own = res.rules.some((r) => r.kind === 'WORKING') || res.exceptions.some((e) => e.kind === 'OPEN');
  if (own) return scheduleWorks(loc, date, minute) && scheduleWorks(res, date, minute);
  const iso = formatLocalDate(date);
  const wd = isoWeekday(date);
  const onBreak = res.rules.some((r) => r.kind === 'BREAK' && r.weekday === wd && minute >= r.startMin && minute < r.endMin);
  const closed = res.exceptions.some((e) => e.kind === 'CLOSED' && covers(e, iso) && inWindow(e, minute));
  return scheduleWorks(loc, date, minute) && !onBreak && !closed;
}

function oracle(q: SlotQuery): Map<number, string[]> {
  const first = parseLocalDate(q.fromDate);
  const lastExclusive = addDays(first, q.days);
  const base = localToUtcMs(first, 0, q.timezone) - 36 * 60 * MIN;
  const total = (q.days + 3) * 24 * 60;
  const need = q.durationMin + q.bufferMin;
  const earliest = q.nowMs + q.minLeadMin * MIN;
  const latest = q.nowMs + q.maxAdvanceDays * 86_400_000;

  const local = Array.from({ length: total }, (_, i) => utcToLocal(base + i * MIN, q.timezone));
  const inRange = (i: number) => {
    const d = formatLocalDate(local[i]!.date);
    return d >= q.fromDate && d < formatLocalDate(lastExclusive);
  };

  const out = new Map<number, string[]>();
  for (const res of q.resources) {
    // ok[i] = this minute is workable for the resource AND not reserved
    const ok = Array.from({ length: total }, (_, i) => {
      const t = base + i * MIN;
      if (res.busy.some((b) => t >= b.start && t < b.end)) return false;
      return resourceWorks(q.location, res, local[i]!.date, local[i]!.minuteOfDay);
    });
    for (let i = 0; i + need <= total; i++) {
      const t = base + i * MIN;
      if (!inRange(i) || local[i]!.minuteOfDay % q.granularityMin !== 0) continue;
      if (t < earliest || t > latest) continue;
      let feasible = true;
      for (let k = 0; k < need && feasible; k++) {
        feasible = ok[i + k]! && formatLocalDate(local[i + k]!.date) === formatLocalDate(local[i]!.date);
      }
      if (feasible) out.set(t, [...(out.get(t) ?? []), res.resourceId]);
    }
  }
  for (const ids of out.values()) ids.sort();
  return out;
}

// ------------------------------------------------------------------------------------- generators -----
const zones = fc.constantFrom('Asia/Kolkata', 'America/New_York', 'Australia/Lord_Howe', 'Europe/London');
// dates chosen to straddle real DST transitions (and one plain week)
const dates = fc.constantFrom('2026-03-07', '2026-03-28', '2026-10-03', '2026-10-24', '2026-10-31', '2026-06-15');
const grid = fc.constantFrom(5, 10, 15, 20, 30, 60);
const mins5 = (lo: number, hi: number) => fc.integer({ min: lo / 5, max: hi / 5 }).map((n) => n * 5);

function exceptionArb(from: string): fc.Arbitrary<DateException> {
  const d = parseLocalDate(from);
  const date = fc.integer({ min: -1, max: 3 }).map((n) => formatLocalDate(addDays(d, n)));
  return fc
    .tuple(fc.constantFrom<'CLOSED' | 'OPEN'>('CLOSED', 'CLOSED', 'OPEN'), date, fc.integer({ min: 0, max: 2 }), fc.option(fc.tuple(mins5(0, 1380), mins5(5, 300)), { nil: null }))
    .map(([kind, start, span, win]) => ({
      kind,
      startDate: start,
      endDate: formatLocalDate(addDays(parseLocalDate(start), span)),
      startMin: win ? win[0] : kind === 'OPEN' ? 540 : null,
      endMin: win ? Math.min(1440, win[0] + win[1]) : kind === 'OPEN' ? 1020 : null,
    }));
}

/**
 * A realistic week: most days have one working window (optionally with a lunch break); a few are closed.
 * (Fully random rules are mostly empty/overlapping nonsense, which made the property vacuous.)
 */
const denseRules = (openFrom: [number, number], lengthHours: [number, number]): fc.Arbitrary<WeeklyRule[]> =>
  fc
    .tuple(
      ...[1, 2, 3, 4, 5, 6, 7].map((weekday) =>
        fc
          .tuple(
            fc.boolean().map((b) => b || weekday <= 5), // Mon-Fri always, weekends 50/50
            mins5(openFrom[0] * 60, openFrom[1] * 60),
            mins5(lengthHours[0] * 60, lengthHours[1] * 60),
            fc.option(mins5(60, 240), { nil: null }), // lunch break offset from opening
          )
          .map(([isOpen, start, len, lunch]): WeeklyRule[] => {
            if (!isOpen) return [];
            const end = Math.min(1440, start + len);
            const rules: WeeklyRule[] = [{ kind: 'WORKING', weekday, startMin: start, endMin: end }];
            if (lunch !== null && start + lunch + 45 < end) rules.push({ kind: 'BREAK', weekday, startMin: start + lunch, endMin: start + lunch + 45 });
            return rules;
          }),
      ),
    )
    .map((perDay) => perDay.flat());

const scheduleArb = (from: string, hours: { openFrom: [number, number]; length: [number, number] }): fc.Arbitrary<Schedule> =>
  fc.record({
    rules: denseRules(hours.openFrom, hours.length),
    exceptions: fc.array(exceptionArb(from), { maxLength: 2 }),
  });

/** A resource either follows the location (no rules of its own) or has its own shift pattern. */
const resourceScheduleArb = (from: string): fc.Arbitrary<Schedule> =>
  fc.oneof(
    { weight: 1, arbitrary: fc.array(exceptionArb(from), { maxLength: 1 }).map((exceptions): Schedule => ({ rules: [], exceptions: exceptions.filter((e) => e.kind === 'CLOSED') })) },
    { weight: 1, arbitrary: scheduleArb(from, { openFrom: [6, 12], length: [4, 11] }) },
  );

const queryArb: fc.Arbitrary<SlotQuery> = fc
  .tuple(zones, dates, fc.integer({ min: 1, max: 2 }), mins5(5, 90), mins5(0, 20), grid)
  .chain(([timezone, fromDate, days, durationMin, bufferMin, granularityMin]) => {
    const dayStart = localToUtcMs(parseLocalDate(fromDate), 0, timezone);
    const busyArb: fc.Arbitrary<Interval> = fc
      .tuple(fc.integer({ min: -6 * 60, max: (days + 1) * 24 * 60 }), mins5(5, 240))
      .map(([startOffsetMin, len]) => ({ start: dayStart + startOffsetMin * MIN, end: dayStart + (startOffsetMin + len) * MIN }));
    const resourceArb = (i: number): fc.Arbitrary<ResourceSchedule> =>
      fc.tuple(resourceScheduleArb(fromDate), fc.array(busyArb, { maxLength: 3 })).map(([s, busy]) => ({ resourceId: `r${i}`, rules: s.rules, exceptions: s.exceptions, busy }));
    return fc
      .tuple(
        scheduleArb(fromDate, { openFrom: [6, 10], length: [8, 14] }),
        fc.integer({ min: 1, max: 3 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => resourceArb(i)))),
        fc.integer({ min: -2 * 24 * 60, max: 6 * 60 }), // "now": up to two days before the first day, or a few hours in
        mins5(0, 120),
        fc.integer({ min: 3, max: 6 }),
      )
      .map(([location, resources, nowOffsetMin, minLeadMin, maxAdvanceDays]) => ({
        timezone,
        fromDate,
        days,
        durationMin,
        bufferMin,
        granularityMin,
        nowMs: dayStart + nowOffsetMin * MIN,
        minLeadMin,
        maxAdvanceDays,
        location,
        resources,
      }));
  });

// -------------------------------------------------------------------------------------- properties -----
describe('computeSlots — properties against an independent minute-by-minute oracle', () => {
  // The oracle is deliberately brute-force (minute resolution), so the default is modest; this was verified
  // at 250 runs. Raise it locally: PROPERTY_RUNS=500 pnpm --filter @tokengo/api test:unit
  const RUNS = Number(process.env['PROPERTY_RUNS'] ?? 60);

  it('offers EXACTLY the feasible slots: nothing infeasible (sound) and nothing missed (complete)', () => {
    let nonEmpty = 0;
    let total = 0;
    fc.assert(
      fc.property(queryArb, (q) => {
        const got = new Map(computeSlots(q).map((s) => [s.startMs, s.resourceIds]));
        const want = oracle(q);
        total++;
        if (want.size > 0) nonEmpty++;
        expect([...got.entries()].sort(([a], [b]) => a - b)).toEqual([...want.entries()].sort(([a], [b]) => a - b));
      }),
      { numRuns: RUNS },
    );
    // Guard against a vacuous pass: most generated cases must actually contain slots to compare.
    expect(nonEmpty / total).toBeGreaterThan(0.3);
  });

  it('slots are strictly ascending, unique per start, and each has the customer-visible duration', () => {
    fc.assert(
      fc.property(queryArb, (q) => {
        const slots = computeSlots(q);
        for (let i = 1; i < slots.length; i++) expect(slots[i]!.startMs).toBeGreaterThan(slots[i - 1]!.startMs);
        for (const s of slots) {
          expect(s.endMs - s.startMs).toBe(q.durationMin * MIN);
          expect(s.resourceIds.length).toBeGreaterThan(0);
          expect(new Set(s.resourceIds).size).toBe(s.resourceIds.length);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('is monotonic: adding a reservation can only REMOVE offered starts, never create new ones', () => {
    fc.assert(
      fc.property(queryArb, fc.integer({ min: 0, max: 2 * 24 * 60 }), mins5(5, 240), (q, offsetMin, len) => {
        const before = new Set(computeSlots(q).map((s) => s.startMs));
        const dayStart = localToUtcMs(parseLocalDate(q.fromDate), 0, q.timezone);
        const extra: Interval = { start: dayStart + offsetMin * MIN, end: dayStart + (offsetMin + len) * MIN };
        const withBusy = { ...q, resources: q.resources.map((r, i) => (i === 0 ? { ...r, busy: [...r.busy, extra] } : r)) };
        for (const s of computeSlots(withBusy)) expect(before.has(s.startMs)).toBe(true);
      }),
      { numRuns: 120 },
    );
  });

  it('is deterministic (same input, same output)', () => {
    fc.assert(
      fc.property(queryArb, (q) => {
        expect(computeSlots(q)).toEqual(computeSlots(structuredClone(q)));
      }),
      { numRuns: 60 },
    );
  });
});
