import type { MoneyJson } from './money';

export type { MoneyJson };

/** Cursor pagination used by every list endpoint: `meta.next_cursor` is the id to pass as `cursor` for the next page (null = last page). */
export interface PageMeta {
  next_cursor: string | null;
}

export type SearchParams = Record<string, string | string[] | undefined>;

/** First value of a (possibly repeated) query parameter, or undefined. */
export function param(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === '' ? undefined : s;
}

/** Keeps only the listed keys (dropping empty values) and returns them as a plain record ready for an API query. */
export function pick(sp: SearchParams, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = param(sp, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
