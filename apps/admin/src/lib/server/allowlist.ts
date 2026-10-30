/**
 * What the browser may ask the BFF to forward to the API. Default deny: a request that matches no rule never leaves this server.
 * Only `admin/*` routes are reachable (never `auth/*`, `users/*` or customer/provider routes), and each state-changing route is listed by name.
 *
 * EXTENSION POINT: when a new admin feature adds an endpoint, add ONE rule here (and a test in allowlist.test.ts).
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const re = (s: string) => new RegExp(`^${s}$`, 'i');

interface Rule {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  pattern: RegExp;
}

export const BFF_RULES: readonly Rule[] = [
  // Every admin read.
  { method: 'GET', pattern: re('admin/[A-Za-z0-9/_.:-]+') },

  // Provider verification workflow
  { method: 'POST', pattern: re(`admin/providers/${UUID}/(start-review|approve|reject|suspend|reinstate)`) },

  // Catalog
  { method: 'POST', pattern: re('admin/categories') },
  { method: 'PATCH', pattern: re(`admin/categories/${UUID}`) },
  { method: 'POST', pattern: re(`admin/categories/${UUID}/service-types`) },
  { method: 'PATCH', pattern: re(`admin/service-types/${UUID}`) },
  { method: 'POST', pattern: re('admin/commission-rules') },
  { method: 'POST', pattern: re('admin/cancellation-policies') },

  // Payments
  { method: 'POST', pattern: re('admin/payments/refunds') },
  { method: 'POST', pattern: re('admin/payments/reconciliation') },

  // Payouts
  { method: 'POST', pattern: re('admin/payouts/run') },
  { method: 'POST', pattern: re('admin/payouts/reconciliation') },
  { method: 'POST', pattern: re(`admin/payouts/providers/${UUID}/(freeze|unfreeze)`) },
  { method: 'POST', pattern: re(`admin/payouts/${UUID}/refresh`) },

  // Platform
  { method: 'PUT', pattern: re('admin/settings/[a-z0-9_.]{1,80}') },

  // Users & roles
  { method: 'POST', pattern: re(`admin/users/${UUID}/(suspend|reinstate|roles|roles/revoke)`) },
];

/** A path segment may only contain these characters: no dot-dot, no encoded slash, no query smuggling. */
const SEGMENT = /^[A-Za-z0-9_.:-]+$/;

export function normalizePath(segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  for (const s of segments) if (!SEGMENT.test(s) || s === '.' || s === '..') return null;
  return segments.join('/');
}

export type AllowDecision = { allowed: true; path: string } | { allowed: false; reason: 'bad_path' | 'not_allowed' | 'method' };

export function checkAllowed(method: string, segments: readonly string[]): AllowDecision {
  const path = normalizePath(segments);
  if (!path) return { allowed: false, reason: 'bad_path' };
  const m = method.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(m)) return { allowed: false, reason: 'method' };
  return BFF_RULES.some((r) => r.method === m && r.pattern.test(path)) ? { allowed: true, path } : { allowed: false, reason: 'not_allowed' };
}
