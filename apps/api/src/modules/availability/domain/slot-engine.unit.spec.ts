import { formatHHMM, localToUtcMs, parseHHMM, parseLocalDate, tzOffsetMinutes, utcToLocal } from './local-time';
import { DateException, Interval, ResourceSchedule, Schedule, SlotQuery, WeeklyRule, computeSlots, isOpenAt, occupiedInterval } from './slot-engine';

const IST = 'Asia/Kolkata';
const MON = 1; // 2026-10-12 is a Monday
const DATE = '2026-10-12';

const rule = (kind: WeeklyRule['kind'], weekday: number, start: string, end: string): WeeklyRule => ({
  kind,
  weekday,
  startMin: parseHHMM(start),
  endMin: end === '24:00' ? 1440 : parseHHMM(end),
});
const week = (start: string, end: string, days = [1, 2, 3, 4, 5, 6]): WeeklyRule[] => days.map((d) => rule('WORKING', d, start, end));
const closed = (startDate: string, endDate: string, start: string | null = null, end: string | null = null): DateException => ({
  kind: 'CLOSED',
  startDate,
  endDate,
  startMin: start ? parseHHMM(start) : null,
  endMin: end ? parseHHMM(end) : null,
});
const open = (startDate: string, endDate: string, start: string, end: string): DateException => ({
  kind: 'OPEN',
  startDate,
  endDate,
  startMin: parseHHMM(start),
  endMin: parseHHMM(end),
});
const chair = (id: string, schedule: Partial<Schedule> = {}, busy: Interval[] = []): ResourceSchedule => ({
  resourceId: id,
  rules: schedule.rules ?? [],
  exceptions: schedule.exceptions ?? [],
  busy,
});
const at = (date: string, hhmm: string, tz = IST) => localToUtcMs(parseLocalDate(date), parseHHMM(hhmm), tz);
const localStarts = (slots: { startMs: number }[], tz = IST) => slots.map((s) => formatHHMM(utcToLocal(s.startMs, tz).minuteOfDay));

function query(over: Partial<SlotQuery> = {}): SlotQuery {
  return {
    timezone: IST,
    fromDate: DATE,
    days: 1,
    durationMin: 30,
    bufferMin: 0,
    granularityMin: 15,
    nowMs: Date.UTC(2026, 9, 10), // two days earlier: lead time / advance window are not binding
    minLeadMin: 0,
    maxAdvanceDays: 60,
    location: { rules: week('09:00', '18:00'), exceptions: [] },
    resources: [chair('r1')],
    ...over,
  };
}

describe('time handling', () => {
  it('IST is a fixed +05:30 and 09:00 IST is 03:30Z', () => {
    expect(tzOffsetMinutes(Date.UTC(2026, 9, 12), IST)).toBe(330);
    expect(at(DATE, '09:00')).toBe(Date.UTC(2026, 9, 12, 3, 30));
  });

  it('round-trips local <-> UTC around DST changes (New York)', () => {
    const ny = 'America/New_York';
    const summer = at('2026-07-01', '09:00', ny);
    const winter = at('2026-12-01', '09:00', ny);
    expect(new Date(summer).toISOString()).toBe('2026-07-01T13:00:00.000Z'); // EDT, UTC-4
    expect(new Date(winter).toISOString()).toBe('2026-12-01T14:00:00.000Z'); // EST, UTC-5
    expect(utcToLocal(summer, ny).minuteOfDay).toBe(540);
  });

  it('rejects malformed dates/times', () => {
    expect(() => parseLocalDate('2026-02-30')).toThrow(RangeError);
    expect(() => parseLocalDate('12/10/2026')).toThrow(RangeError);
    expect(() => parseHHMM('24:00')).toThrow(RangeError);
    expect(() => parseHHMM('9:00')).toThrow(RangeError);
  });
});

describe('computeSlots — core behaviour', () => {
  it('fills a normal day on the granularity grid (09:00–18:00, 30 min, 15-min grid => 35 slots)', () => {
    const slots = computeSlots(query());
    const starts = localStarts(slots);
    expect(starts[0]).toBe('09:00');
    expect(starts[starts.length - 1]).toBe('17:30');
    expect(slots).toHaveLength(35);
    expect(slots[0]!.endMs - slots[0]!.startMs).toBe(30 * 60_000);
    expect(slots[0]!.startMs).toBe(Date.UTC(2026, 9, 12, 3, 30)); // stored/returned in UTC
  });

  it('keeps the post-service buffer inside opening hours', () => {
    const starts = localStarts(computeSlots(query({ durationMin: 30, bufferMin: 10 })));
    expect(starts[starts.length - 1]).toBe('17:15'); // 17:15 + 40 min = 17:55 ✓ ; 17:30 + 40 = 18:10 ✗
  });

  it('respects breaks: a service may END at the break start but never overlap it', () => {
    const location = { rules: [...week('09:00', '18:00'), rule('BREAK', MON, '13:00', '14:00')], exceptions: [] };
    const starts = localStarts(computeSlots(query({ location })));
    expect(starts).toContain('12:30'); // 12:30–13:00
    expect(starts).not.toContain('12:45');
    expect(starts).not.toContain('13:30');
    expect(starts).toContain('14:00');
  });

  it('removes slots that overlap existing reservations (buffer included) and keeps adjacent ones', () => {
    const booked = occupiedInterval(at(DATE, '10:00'), 30, 10); // occupies 10:00–10:40
    const starts = localStarts(computeSlots(query({ resources: [chair('r1', {}, [booked])] })));
    expect(starts).not.toContain('09:45'); // 09:45–10:15 overlaps
    expect(starts).toContain('09:30'); // 09:30–10:00 fits right before
    expect(starts).not.toContain('10:30');
    expect(starts).toContain('10:45'); // first grid point at/after the reservation ends
  });

  it('applies minimum lead time and maximum advance window', () => {
    const now = at(DATE, '09:10');
    const lead = localStarts(computeSlots(query({ nowMs: now, minLeadMin: 60 })));
    expect(lead[0]).toBe('10:15'); // 09:10 + 60 min = 10:10 -> next grid point
    const far = computeSlots(query({ days: 10, nowMs: at(DATE, '00:00'), maxAdvanceDays: 2 }));
    const lastLocalDate = utcToLocal(far[far.length - 1]!.startMs, IST).date;
    expect(lastLocalDate.day).toBeLessThanOrEqual(14);
  });

  it('closed weekdays and holiday exceptions yield nothing; partial closures remove only that window', () => {
    expect(computeSlots(query({ fromDate: '2026-10-18' }))).toHaveLength(0); // Sunday: no rule
    expect(computeSlots(query({ location: { rules: week('09:00', '18:00'), exceptions: [closed(DATE, DATE)] } }))).toHaveLength(0);
    const partial = localStarts(computeSlots(query({ location: { rules: week('09:00', '18:00'), exceptions: [closed(DATE, DATE, '11:00', '12:00')] } })));
    expect(partial).toContain('10:30');
    expect(partial).not.toContain('10:45');
    expect(partial).not.toContain('11:30');
    expect(partial).toContain('12:00');
  });

  it('a special OPEN exception adds hours on a normally closed day', () => {
    const slots = computeSlots(query({ fromDate: '2026-10-18', location: { rules: week('09:00', '18:00'), exceptions: [open('2026-10-18', '2026-10-18', '10:00', '12:00')] } }));
    expect(localStarts(slots)).toEqual(['10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30']);
  });

  it('multi-day exceptions (leave) cover every date in the range inclusive', () => {
    const exceptions = [closed('2026-10-12', '2026-10-14')];
    const slots = computeSlots(query({ days: 4, location: { rules: week('09:00', '18:00'), exceptions } }));
    const days = new Set(slots.map((s) => utcToLocal(s.startMs, IST).date.day));
    expect([...days]).toEqual([15]);
  });
});

describe('computeSlots — staff (resources)', () => {
  it('a resource with no schedule follows the location hours', () => {
    expect(computeSlots(query({ resources: [chair('a')] }))).toHaveLength(35);
  });

  it('a resource with its own schedule is bounded by BOTH its hours and the location hours', () => {
    const early = chair('a', { rules: week('07:00', '12:00') }); // starts before the shop opens
    const starts = localStarts(computeSlots(query({ resources: [early] })));
    expect(starts[0]).toBe('09:00');
    expect(starts[starts.length - 1]).toBe('11:30');
  });

  it("one stylist's leave does not affect the others; shared starts list every free stylist", () => {
    const onLeave = chair('riya', { exceptions: [closed(DATE, DATE)] });
    const free = chair('amit');
    const slots = computeSlots(query({ resources: [onLeave, free] }));
    expect(slots).toHaveLength(35);
    expect(slots.every((s) => s.resourceIds.join() === 'amit')).toBe(true);

    const both = computeSlots(query({ resources: [chair('riya'), chair('amit')] }));
    expect(both[0]!.resourceIds).toEqual(['amit', 'riya']);
  });

  it('a start is offered as long as ANY stylist is free; it disappears only when ALL are busy', () => {
    const busy = [occupiedInterval(at(DATE, '10:00'), 30, 0)];
    const one = computeSlots(query({ resources: [chair('a', {}, busy), chair('b')] }));
    expect(one.find((s) => localStarts([s])[0] === '10:00')!.resourceIds).toEqual(['b']);
    const none = computeSlots(query({ resources: [chair('a', {}, busy), chair('b', {}, busy)] }));
    expect(localStarts(none)).not.toContain('10:00');
  });

  it('personal breaks apply to that stylist only', () => {
    const lunch = chair('a', { rules: [rule('BREAK', MON, '12:00', '13:00')] });
    const slots = computeSlots(query({ resources: [lunch, chair('b')] }));
    const noon = slots.find((s) => localStarts([s])[0] === '12:15')!;
    expect(noon.resourceIds).toEqual(['b']);
  });

  it('no resources, zero duration or non-positive days return no slots (no throw)', () => {
    expect(computeSlots(query({ resources: [] }))).toEqual([]);
    expect(computeSlots(query({ durationMin: 0 }))).toEqual([]);
    expect(computeSlots(query({ days: 0 }))).toEqual([]);
  });
});

describe('computeSlots — DST and half-hour zones', () => {
  const ny = 'America/New_York';
  const allDay = (): Schedule => ({ rules: week('00:00', '24:00', [1, 2, 3, 4, 5, 6, 7]), exceptions: [] });
  const hourly = (date: string, tz: string) =>
    computeSlots(query({ timezone: tz, fromDate: date, durationMin: 60, granularityMin: 60, nowMs: Date.UTC(2026, 0, 1), maxAdvanceDays: 1000, location: allDay() }));

  it('spring-forward day (2026-03-08) has 23 hourly slots and none in the missing 02:00 hour', () => {
    const slots = hourly('2026-03-08', ny);
    expect(slots).toHaveLength(23);
    expect(localStarts(slots, ny)).not.toContain('02:00');
    expect(localStarts(slots, ny)).toContain('03:00');
  });

  it('fall-back day (2026-11-01) has 25 hourly slots (the 01:00 hour happens twice)', () => {
    const slots = hourly('2026-11-01', ny);
    expect(slots).toHaveLength(25);
    expect(localStarts(slots, ny).filter((s) => s === '01:00')).toHaveLength(2);
  });

  it('a normal day in the same zone has 24', () => {
    expect(hourly('2026-06-10', ny)).toHaveLength(24);
  });

  it('stays on the local grid when a 30-minute DST shift falls inside the window (Lord Howe)', () => {
    const lh = 'Australia/Lord_Howe'; // DST starts first Sunday of October: 2026-10-04, clocks +30 min
    const slots = computeSlots(query({ timezone: lh, fromDate: '2026-10-04', durationMin: 60, granularityMin: 60, nowMs: Date.UTC(2026, 0, 1), maxAdvanceDays: 1000, location: allDay() }));
    expect(slots.length).toBeGreaterThan(20);
    for (const s of slots) expect(utcToLocal(s.startMs, lh).minuteOfDay % 60).toBe(0);
  });

  it('IST business hours map to the right UTC instants regardless of the server timezone', () => {
    const slots = computeSlots(query());
    expect(new Date(slots[0]!.startMs).toISOString()).toBe('2026-10-12T03:30:00.000Z');
  });
});

describe('isOpenAt (open-now badge)', () => {
  const loc: Schedule = { rules: [...week('09:00', '18:00'), rule('BREAK', MON, '13:00', '14:00')], exceptions: [closed('2026-10-13', '2026-10-13')] };
  it('is true during hours, false at break, before opening, at closing and on holidays', () => {
    expect(isOpenAt(loc, IST, at(DATE, '10:00'))).toBe(true);
    expect(isOpenAt(loc, IST, at(DATE, '13:30'))).toBe(false);
    expect(isOpenAt(loc, IST, at(DATE, '08:59'))).toBe(false);
    expect(isOpenAt(loc, IST, at(DATE, '18:00'))).toBe(false);
    expect(isOpenAt(loc, IST, at('2026-10-13', '10:00'))).toBe(false);
  });
});
