import { describe, expect, it } from 'vitest';
import { tierSentences } from './components/cancellation-form';
import { scheduleError } from './components/version-fields';
import { describeRate } from './format';
import { groupByScope, validateTiers, versionState } from './versioning';

const NOW = Date.parse('2026-10-07T12:00:00Z');

describe('version state', () => {
  it('distinguishes current, scheduled and superseded versions', () => {
    expect(versionState({ effective_from: '2020-01-01T00:00:00Z', effective_to: null }, NOW)).toBe('current');
    expect(versionState({ effective_from: '2026-10-07T12:00:00Z', effective_to: null }, NOW)).toBe('current');
    expect(versionState({ effective_from: '2026-11-01T00:00:00Z', effective_to: null }, NOW)).toBe('scheduled');
    expect(versionState({ effective_from: '2020-01-01T00:00:00Z', effective_to: '2026-10-01T00:00:00Z' }, NOW)).toBe('superseded');
    expect(versionState({ effective_from: '2020-01-01T00:00:00Z', effective_to: '2026-12-01T00:00:00Z' }, NOW)).toBe('current'); // closing in the future: still in force
  });
});

describe('grouping history by scope', () => {
  it('groups by scope, newest version first, platform before specific scopes', () => {
    const rows = [
      { id: 'a', scope_type: 'CATEGORY', scope_id: 'c1', version: 1 },
      { id: 'b', scope_type: 'PLATFORM', scope_id: null, version: 1 },
      { id: 'c', scope_type: 'PLATFORM', scope_id: null, version: 3 },
      { id: 'd', scope_type: 'PLATFORM', scope_id: null, version: 2 },
      { id: 'e', scope_type: 'PROVIDER', scope_id: 'p1', version: 1 },
    ];
    const groups = groupByScope(rows);
    expect(groups.map((g) => g.key)).toEqual(['PLATFORM:', 'CATEGORY:c1', 'PROVIDER:p1']);
    expect(groups[0]!.versions.map((v) => v.version)).toEqual([3, 2, 1]);
  });
});

describe('cancellation refund tiers (mirrors the API rules)', () => {
  it('accepts a sensible ladder', () => {
    expect(validateTiers([{ hours: 24, refundBps: 10000 }, { hours: 4, refundBps: 5000 }, { hours: 0, refundBps: 0 }])).toEqual([]);
    expect(validateTiers([{ hours: 0, refundBps: 10000 }])).toEqual([]);
  });
  it('requires a tier for 0 hours', () => {
    expect(validateTiers([{ hours: 24, refundBps: 10000 }]).join(' ')).toMatch(/0 hours/);
  });
  it('requires different hours per tier', () => {
    expect(validateTiers([{ hours: 0, refundBps: 0 }, { hours: 0, refundBps: 100 }]).join(' ')).toMatch(/different/);
  });
  it('never lets the refund grow as the appointment gets closer', () => {
    expect(validateTiers([{ hours: 24, refundBps: 5000 }, { hours: 0, refundBps: 10000 }]).join(' ')).toMatch(/cannot increase/);
    // order of entry does not matter
    expect(validateTiers([{ hours: 0, refundBps: 0 }, { hours: 24, refundBps: 10000 }, { hours: 4, refundBps: 5000 }])).toEqual([]);
  });
  it('limits the number of tiers and rejects an empty list', () => {
    expect(validateTiers([])).toHaveLength(1);
    const many = Array.from({ length: 11 }, (_, i) => ({ hours: i, refundBps: 0 }));
    expect(validateTiers(many).join(' ')).toMatch(/At most 10/);
  });
  it('reads back in plain words', () => {
    expect(tierSentences([{ hours: 0, refundBps: 0 }, { hours: 24, refundBps: 10000 }, { hours: 4, refundBps: 5000 }])).toEqual([
      '24 hours or more before the start: 100% refunded',
      '4 hours or more before the start: 50% refunded',
      'Less than 4 hours before the start: 0% refunded',
    ]);
    expect(tierSentences([{ hours: 0, refundBps: 2500 }])).toEqual(['Any time: 25% refunded']);
  });
});

describe('effective time', () => {
  it('is valid when immediate, and when scheduled in the future (IST)', () => {
    expect(scheduleError('now', '', NOW)).toBeUndefined();
    expect(scheduleError('scheduled', '2026-10-08T10:00', NOW)).toBeUndefined();
  });
  it('rejects the past, nothing at all, and garbage: history is never rewritten', () => {
    expect(scheduleError('scheduled', '2026-10-07T10:00', NOW)).toMatch(/future/);
    expect(scheduleError('scheduled', '', NOW)).toMatch(/Choose/);
    expect(scheduleError('scheduled', 'tomorrow', NOW)).toMatch(/Choose/);
  });
});

describe('rate wording', () => {
  it('shows percentages and fixed amounts', () => {
    expect(describeRate({ kind: 'PERCENT', percent_bps: 1250, fixed: null })).toBe('12.5%');
    expect(describeRate({ kind: 'FIXED', percent_bps: null, fixed: { amount_minor: 2000, currency: 'INR' } })).toBe('₹20 per booking');
  });
});
