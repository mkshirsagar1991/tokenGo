import { CircleCheck, TriangleAlert } from 'lucide-react';
import { Badge, InlineProblem } from '@/components/ui/feedback';
import { Card, StatTile } from '@/components/ui/layout';
import { formatDateTime } from '@/lib/format';
import type { ApiResult } from '@/lib/problem';
import { countOf, formatCount, type Count, type LedgerIntegrity, type PayoutIntegrity, type Readiness, type loadDashboard } from '../load';

type Loaded = Awaited<ReturnType<typeof loadDashboard>>;

function IntegrityCard({ title, result, permission, checkedAt, children }: { title: string; result: ApiResult<{ ok: boolean; violations: unknown[] }>; permission: string; checkedAt?: string; children?: React.ReactNode }) {
  return (
    <Card title={title} actions={result.ok ? <Badge tone={result.data.ok ? 'success' : 'danger'}>{result.data.ok ? 'OK' : `${result.data.violations.length} violation${result.data.violations.length === 1 ? '' : 's'}`}</Badge> : undefined}>
      {result.ok ? (
        <div className="space-y-2 text-sm">
          {result.data.ok ? (
            <p className="flex items-center gap-2 text-success-fg">
              <CircleCheck className="h-4 w-4" aria-hidden /> All checks passed.
            </p>
          ) : (
            <details open className="rounded-lg bg-danger-soft p-3 text-danger-fg">
              <summary className="flex cursor-pointer items-center gap-2 font-medium">
                <TriangleAlert className="h-4 w-4" aria-hidden /> Investigate before moving money
              </summary>
              <ul className="mt-2 space-y-1 break-words font-mono text-xs">
                {result.data.violations.map((v, i) => (
                  <li key={i}>{typeof v === 'string' ? v : JSON.stringify(v)}</li>
                ))}
              </ul>
            </details>
          )}
          {checkedAt ? <p className="text-xs text-fg-subtle">Checked {formatDateTime(checkedAt)}</p> : null}
          {children}
        </div>
      ) : (
        <InlineProblem problem={result.problem} permission={permission} />
      )}
    </Card>
  );
}

function CountTile({ label, count, result, hint, href, warnWhenAny = 'warn', permission }: { label: string; count: Count | null; result?: ApiResult<unknown>; hint?: string; href?: string; warnWhenAny?: 'warn' | 'danger'; permission: string }) {
  if (!count) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</p>
        <div className="mt-2">{result && !result.ok ? <InlineProblem problem={result.problem} permission={permission} /> : <span className="text-fg-subtle">—</span>}</div>
      </div>
    );
  }
  return <StatTile label={label} value={formatCount(count)} hint={hint} href={href} tone={count.value > 0 ? warnWhenAny : 'success'} />;
}

const sum = (...cs: Array<Count | null>): Count | null => (cs.every(Boolean) ? { value: cs.reduce((a, c) => a + c!.value, 0), capped: cs.some((c) => c!.capped) } : null);

export function DashboardView({ d }: { d: Loaded }) {
  const awaiting = sum(countOf(d.submitted), countOf(d.underReview));
  const inFlight = sum(countOf(d.inFlightReserved), countOf(d.inFlightSubmitted));
  const ready = d.ready.ok ? (d.ready.data as Readiness) : null;
  return (
    <div className="space-y-8">
      <section aria-labelledby="integrity-h">
        <h2 id="integrity-h" className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg-subtle">
          Integrity
        </h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <IntegrityCard title="Ledger integrity" result={d.ledger as ApiResult<LedgerIntegrity>} permission="ledger:read" checkedAt={d.ledger.ok ? d.ledger.data.checkedAt : undefined} />
          <IntegrityCard title="Payout integrity" result={d.payouts as ApiResult<PayoutIntegrity>} permission="payout:read_any">
            {d.payouts.ok ? (
              <p className="text-xs text-fg-subtle">
                Payable events still waiting to be recorded: <strong className="text-fg-muted">{d.payouts.data.pending_payable_events}</strong>
                {d.payouts.data.pending_payable_events > 0 ? ' (a short-lived difference while the worker catches up is normal)' : ''}
              </p>
            ) : null}
          </IntegrityCard>
          <Card title="Platform health" actions={ready ? <Badge tone={ready.status === 'ok' ? 'success' : 'danger'}>{ready.status === 'ok' ? 'Ready' : 'Unavailable'}</Badge> : undefined}>
            {ready ? (
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-fg-subtle">Database</dt><dd className="text-fg">{ready.checks?.database ?? '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-fg-subtle">Worker backlog</dt><dd className="text-fg">{ready.outbox ? `${ready.outbox.pending} event${ready.outbox.pending === 1 ? '' : 's'}${ready.outbox.oldest_pending_seconds ? `, oldest ${ready.outbox.oldest_pending_seconds}s` : ''}` : '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-fg-subtle">API latency</dt><dd className="text-fg">{ready.latency_ms !== undefined ? `${ready.latency_ms} ms` : '—'}</dd></div>
              </dl>
            ) : !d.ready.ok ? (
              <InlineProblem problem={d.ready.problem} />
            ) : null}
          </Card>
        </div>
      </section>

      <section aria-labelledby="attention-h">
        <h2 id="attention-h" className="mb-1 text-sm font-semibold uppercase tracking-wide text-fg-subtle">
          Needs attention
        </h2>
        <p className="mb-3 text-xs text-fg-subtle">Counts come from the API&apos;s lists, which return at most 100 per query; a trailing “+” means there are more.</p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <CountTile label="Providers awaiting review" count={awaiting} result={d.submitted.ok ? d.underReview : d.submitted} hint="Submitted + under review" href="/providers?status=SUBMITTED" permission="provider:read_any" />
          <CountTile label="Payouts in flight" count={inFlight} result={d.inFlightReserved.ok ? d.inFlightSubmitted : d.inFlightReserved} hint="Reserved or submitted, not yet paid" href="/payouts?status=SUBMITTED" permission="payout:read_any" />
          <CountTile label="Payouts needing review" count={countOf(d.needsReview)} result={d.needsReview} hint="Contradictory provider answers; money paused" href="/payouts?needs_review=true" warnWhenAny="danger" permission="payout:read_any" />
          <CountTile label="Failed payouts" count={countOf(d.failedPayouts)} result={d.failedPayouts} href="/payouts?status=FAILED" permission="payout:read_any" />
          <CountTile label="Quarantined payments" count={countOf(d.quarantined)} result={d.quarantined} hint="Captured but not matching the intent; not credited" href="/payments/transactions?status=QUARANTINED" warnWhenAny="danger" permission="payments:read" />
          <CountTile label="Open refunds" count={countOf(d.openRefunds)} result={d.openRefunds} hint="Processing at the payment provider" href="/payments/refunds?status=PROCESSING" permission="payments:read" />
          <CountTile label="Providers with payouts paused" count={d.holds.ok ? { value: d.holds.data.length, capped: false } : null} result={d.holds} hint="Frozen by an operator or automatically" href="/payouts/holds" permission="payout:read_any" />
        </div>
      </section>
    </div>
  );
}
