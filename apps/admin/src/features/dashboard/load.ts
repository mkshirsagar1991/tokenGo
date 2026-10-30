import type { PageMeta } from '@/lib/api-types';
import { apiRequest } from '@/lib/server/api-client';
import { serverApi } from '@/lib/server/api';
import type { ApiResult } from '@/lib/problem';

export interface IntegrityViolation {
  check?: string;
  detail?: unknown;
}
export interface LedgerIntegrity {
  ok: boolean;
  checkedAt: string;
  violations: IntegrityViolation[];
}
export interface PayoutIntegrity {
  ok: boolean;
  violations: string[];
  pending_payable_events: number;
}
export interface Readiness {
  status: string;
  checks?: { database?: string };
  outbox?: { pending: number; oldest_pending_seconds: number | null } | null;
  environment?: string;
  latency_ms?: number;
}

/** A count taken from a capped list (the API pages at 100): "100+" when more exist. */
export interface Count {
  value: number;
  capped: boolean;
}

export const countOf = (r: ApiResult<unknown[], PageMeta>): Count | null => (r.ok ? { value: r.data.length, capped: Boolean(r.meta?.next_cursor) } : null);
export const formatCount = (c: Count): string => `${c.value}${c.capped ? '+' : ''}`;

const list = (path: string, query: Record<string, string>) => serverApi<unknown[], PageMeta>(path, { query: { ...query, limit: 100 } });

/** Everything the dashboard can answer from the existing API. Each probe is independent: one failing (or being forbidden) never blanks the page. */
export async function loadDashboard() {
  const [ledger, payouts, submitted, underReview, inFlightReserved, inFlightSubmitted, needsReview, failedPayouts, quarantined, openRefunds, holds, ready] = await Promise.all([
    serverApi<LedgerIntegrity>('/admin/ledger/integrity'),
    serverApi<PayoutIntegrity>('/admin/payouts/integrity'),
    list('/admin/providers', { status: 'SUBMITTED' }),
    list('/admin/providers', { status: 'UNDER_REVIEW' }),
    list('/admin/payouts', { status: 'RESERVED' }),
    list('/admin/payouts', { status: 'SUBMITTED' }),
    list('/admin/payouts', { needs_review: 'true' }),
    list('/admin/payouts', { status: 'FAILED' }),
    list('/admin/payments/transactions', { status: 'QUARANTINED' }),
    list('/admin/payments/refunds', { status: 'PROCESSING' }),
    serverApi<unknown[]>('/admin/payouts/holds'),
    apiRequest<Readiness>('/health/ready', { timeoutMs: 4000 }),
  ]);
  return { ledger, payouts, submitted, underReview, inFlightReserved, inFlightSubmitted, needsReview, failedPayouts, quarantined, openRefunds, holds, ready };
}
