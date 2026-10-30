import { describe, expect, it } from 'vitest';
import { activeHref, visibleNav } from '@/config/navigation';
import { displayValue, parseDraft, sameValue } from './parse';
import type { SettingView } from './types';

const str = (c: SettingView['constraints']) => ({ kind: 'string' as const, constraints: c });

describe('setting drafts', () => {
  it('trims strings and enforces length and the semantic-version hint', () => {
    expect(parseDraft(str({ max_length: 12, hint: 'like 1.4.0' }), ' 1.4.0 ')).toEqual({ ok: true, value: '1.4.0' });
    expect(parseDraft(str({ max_length: 12, hint: 'like 1.4.0' }), 'one')).toMatchObject({ ok: false });
    expect(parseDraft(str({ max_length: 12, hint: 'like 1.4.0' }), '')).toEqual({ ok: true, value: '' }); // empty means "none"
    expect(parseDraft(str({ max_length: 5 }), 'abcdef')).toMatchObject({ ok: false, error: 'At most 5 characters.' });
  });

  it('parses whole numbers within bounds', () => {
    const s = { kind: 'int' as const, constraints: { min: 15, max: 1440 } };
    expect(parseDraft(s, '120')).toEqual({ ok: true, value: 120 });
    expect(parseDraft(s, '14')).toMatchObject({ ok: false, error: 'At least 15.' });
    expect(parseDraft(s, '1441')).toMatchObject({ ok: false });
    expect(parseDraft(s, '12.5')).toMatchObject({ ok: false });
    expect(parseDraft(s, '-3')).toMatchObject({ ok: false });
    expect(parseDraft(s, '')).toMatchObject({ ok: false });
  });

  it('parses an increasing list of paise amounts with item limits', () => {
    const s = { kind: 'int_list' as const, constraints: { min: 1000, max: 5_000_000, min_items: 1, max_items: 3, ascending: true } };
    expect(parseDraft(s, '10000, 20000,50000')).toEqual({ ok: true, value: [10000, 20000, 50000] });
    expect(parseDraft(s, '20000, 10000')).toMatchObject({ ok: false, error: expect.stringContaining('increasing') });
    expect(parseDraft(s, '10000, 10000')).toMatchObject({ ok: false });
    expect(parseDraft(s, '500')).toMatchObject({ ok: false });
    expect(parseDraft(s, '1000, 2000, 3000, 4000')).toMatchObject({ ok: false, error: expect.stringContaining('At most 3') });
    expect(parseDraft(s, '')).toMatchObject({ ok: false });
    expect(parseDraft(s, '1000, abc')).toMatchObject({ ok: false });
  });

  it('shows paise settings in rupees too, and compares values structurally', () => {
    expect(displayValue('topup.presets_minor', 'int_list', [10000, 250000])).toBe('₹100, ₹2,500 (10000, 250000 paise)');
    expect(displayValue('disputes.operator_limit_minor', 'int', 500000)).toBe('500000 paise (₹5,000)');
    expect(displayValue('features.reviews_enabled', 'bool', true)).toBe('On');
    expect(displayValue('support.hours', 'string', '')).toBe('(empty)');
    expect(sameValue([1, 2], [1, 2])).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });
});

describe('role-specific navigation', () => {
  const labels = (perms: string[]) => visibleNav(perms).flatMap((g) => g.items.map((i) => i.label));

  it('shows only the dashboard to someone with no permissions', () => {
    expect(labels([])).toEqual(['Dashboard']);
  });

  it('gives a support operator people and read-only money views, but not settings, catalog management or reports', () => {
    const support = ['provider:read_any', 'user:read_any', 'role:read', 'payments:read', 'payout:read_any'];
    const l = labels(support);
    expect(l).toEqual(expect.arrayContaining(['Providers', 'Users', 'Roles', 'Transactions', 'Payouts']));
    for (const hidden of ['Settings', 'Categories & services', 'Commission rules', 'Reports', 'Audit log']) expect(l).not.toContain(hidden);
  });

  it('drops groups that end up empty', () => {
    expect(visibleNav(['report:read']).map((g) => g.label)).toEqual(['Overview', 'Insight']);
  });

  it('highlights the most specific matching item', () => {
    const groups = visibleNav(['category:manage', 'pricing:read', 'payout:read_any']);
    expect(activeHref('/catalog', groups)).toBe('/catalog');
    expect(activeHref('/catalog/commission', groups)).toBe('/catalog/commission');
    expect(activeHref('/catalog/categories/abc', groups)).toBe('/catalog');
    expect(activeHref('/payouts/holds', groups)).toBe('/payouts/holds');
    expect(activeHref('/payouts/123', groups)).toBe('/payouts');
    expect(activeHref('/', groups)).toBe('/');
    expect(activeHref('/unknown', groups)).toBeNull();
  });
});
