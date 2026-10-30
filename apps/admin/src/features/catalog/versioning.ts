/**
 * Commission rules and cancellation policies are VERSIONED and append-only: a change closes the current version at the new
 * version's effective time and opens the next. These helpers describe that history; they never invent data.
 */
export type VersionState = 'current' | 'scheduled' | 'superseded';

export function versionState(v: { effective_from: string; effective_to: string | null }, now: number): VersionState {
  if (Date.parse(v.effective_from) > now) return 'scheduled';
  if (v.effective_to !== null && Date.parse(v.effective_to) <= now) return 'superseded';
  return 'current';
}

export interface ScopeGroup<T> {
  key: string;
  scope_type: string;
  scope_id: string | null;
  /** Newest version first. */
  versions: T[];
}

export function groupByScope<T extends { scope_type: string; scope_id: string | null; version: number }>(rows: readonly T[]): Array<ScopeGroup<T>> {
  const map = new Map<string, ScopeGroup<T>>();
  for (const r of rows) {
    const key = `${r.scope_type}:${r.scope_id ?? ''}`;
    const g = map.get(key) ?? { key, scope_type: r.scope_type, scope_id: r.scope_id, versions: [] };
    g.versions.push(r);
    map.set(key, g);
  }
  const order = ['PLATFORM', 'CATEGORY', 'SERVICE_TYPE', 'PROVIDER', 'PROVIDER_SERVICE'];
  const groups = [...map.values()];
  for (const g of groups) g.versions.sort((a, b) => b.version - a.version);
  return groups.sort((a, b) => order.indexOf(a.scope_type) - order.indexOf(b.scope_type) || a.key.localeCompare(b.key));
}

export interface Tier {
  hours: number;
  refundBps: number;
}

/** Mirrors the API's rules for refund tiers so the form can say what is wrong before submitting (the API still decides). */
export function validateTiers(tiers: readonly Tier[]): string[] {
  const problems: string[] = [];
  if (tiers.length === 0) return ['Add at least one tier.'];
  if (tiers.length > 10) problems.push('At most 10 tiers.');
  if (!tiers.some((t) => t.hours === 0)) problems.push('A tier for 0 hours before the start is required: it says what applies at the last minute.');
  if (new Set(tiers.map((t) => t.hours)).size !== tiers.length) problems.push('Each tier needs a different number of hours.');
  const sorted = [...tiers].sort((a, b) => b.hours - a.hours);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.refundBps > sorted[i - 1]!.refundBps) {
      problems.push('The refund cannot increase as the appointment gets closer (more notice must never be penalised).');
      break;
    }
  }
  return problems;
}

/** The newest version (highest number) already recorded for a scope, or null. Used to say what a new version will replace. */
export function latestForScope<T extends { scope_type: string; scope_id: string | null; version: number }>(rows: readonly T[], scope: { type: string; id: string }): T | null {
  const id = scope.type === 'PLATFORM' ? null : scope.id;
  const mine = rows.filter((r) => r.scope_type === scope.type && r.scope_id === id);
  return mine.reduce<T | null>((best, r) => (best === null || r.version > best.version ? r : best), null);
}
