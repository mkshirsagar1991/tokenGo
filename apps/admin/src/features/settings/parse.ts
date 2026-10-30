import { formatInr } from '@/lib/money';
import type { SettingValue, SettingView } from './types';

/**
 * Client-side parsing and validation of a setting's draft text. It mirrors the API's registry rules so mistakes are shown while
 * typing; the API still validates everything and its message is shown if it disagrees.
 */
export type Parsed = { ok: true; value: SettingValue } | { ok: false; error: string };

const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function parseDraft(s: Pick<SettingView, 'kind' | 'constraints'>, draft: string | boolean): Parsed {
  const c = s.constraints;
  switch (s.kind) {
    case 'bool':
      return typeof draft === 'boolean' ? { ok: true, value: draft } : { ok: false, error: 'Choose on or off.' };
    case 'string': {
      const v = String(draft).trim();
      if (c.max_length !== undefined && v.length > c.max_length) return { ok: false, error: `At most ${c.max_length} characters.` };
      if (v !== '' && c.hint === 'like 1.4.0' && !SEMVER.test(v)) return { ok: false, error: 'Must look like 1.4.0.' };
      return { ok: true, value: v };
    }
    case 'int': {
      const v = String(draft).trim();
      if (!/^\d+$/.test(v)) return { ok: false, error: 'Enter a whole number.' };
      const n = Number(v);
      if (!Number.isSafeInteger(n)) return { ok: false, error: 'That number is too large.' };
      if (c.min !== undefined && n < c.min) return { ok: false, error: `At least ${c.min}.` };
      if (c.max !== undefined && n > c.max) return { ok: false, error: `At most ${c.max}.` };
      return { ok: true, value: n };
    }
    case 'int_list': {
      const parts = String(draft)
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
      if (parts.some((p) => !/^\d+$/.test(p))) return { ok: false, error: 'Enter whole numbers separated by commas.' };
      const list = parts.map(Number);
      if (list.some((n) => !Number.isSafeInteger(n))) return { ok: false, error: 'A number is too large.' };
      if (c.min_items !== undefined && list.length < c.min_items) return { ok: false, error: `At least ${c.min_items} item(s).` };
      if (c.max_items !== undefined && list.length > c.max_items) return { ok: false, error: `At most ${c.max_items} items.` };
      if (c.min !== undefined && list.some((n) => n < c.min!)) return { ok: false, error: `Each item must be at least ${c.min}.` };
      if (c.max !== undefined && list.some((n) => n > c.max!)) return { ok: false, error: `Each item must be at most ${c.max}.` };
      if (c.ascending && list.some((n, i) => i > 0 && n <= list[i - 1]!)) return { ok: false, error: 'Items must be strictly increasing.' };
      return { ok: true, value: list };
    }
  }
}

export function draftFromValue(kind: SettingView['kind'], value: SettingValue): string | boolean {
  if (kind === 'bool') return Boolean(value);
  if (kind === 'int_list') return (value as number[]).join(', ');
  return String(value);
}

export const sameValue = (a: SettingValue, b: SettingValue): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Human wording for a value; paise settings (key ends with `_minor`) are also shown in rupees. */
export function displayValue(key: string, kind: SettingView['kind'], value: SettingValue): string {
  const minor = key.endsWith('_minor');
  if (kind === 'bool') return value ? 'On' : 'Off';
  if (kind === 'string') return value === '' ? '(empty)' : String(value);
  if (kind === 'int') return minor ? `${value} paise (${formatInr(value as number)})` : String(value);
  const list = value as number[];
  return minor ? list.map((n) => formatInr(n)).join(', ') + ` (${list.join(', ')} paise)` : list.join(', ');
}
