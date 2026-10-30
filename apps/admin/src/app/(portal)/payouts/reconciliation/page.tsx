import type { Metadata } from 'next';
import { RunReconciliationButton } from '@/components/reconciliation/run-reconciliation';
import { ReconciliationResultView } from '@/components/reconciliation/reconciliation-result';
import type { ReconciliationResult } from '@/components/reconciliation/types';
import { Alert, InlineProblem, ProblemView } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/layout';
import { param, type SearchParams } from '@/lib/api-types';
import { isUuid } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Payout reconciliation' };

export default async function PayoutReconciliationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const run = param(sp, 'run');
  const [integrity, result] = await Promise.all([
    serverApi<{ ok: boolean; violations: string[]; pending_payable_events: number }>('/admin/payouts/integrity'),
    run && isUuid(run) ? serverApi<ReconciliationResult>(`/admin/payouts/reconciliation/${run}`) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader title="Payout reconciliation & integrity" description="Integrity checks that our payable rows, payouts and ledger agree with each other, and reconciliation of our payouts against the payout provider's." actions={<RunReconciliationButton endpoint="/admin/payouts/reconciliation" subject="payouts" basePath="/payouts/reconciliation" />} />
      <Card title="Payout integrity" className="mb-6" actions={integrity.ok ? <span className={integrity.data.ok ? 'text-sm font-medium text-success-fg' : 'text-sm font-medium text-danger-fg'}>{integrity.data.ok ? 'OK' : `${integrity.data.violations.length} violation(s)`}</span> : undefined}>
        {integrity.ok ? (
          integrity.data.ok ? (
            <p className="text-sm text-fg-muted">Payable rows equal each provider&apos;s ledger balance, the money in transit equals the open payouts, every payout equals its payables, and states agree. {integrity.data.pending_payable_events > 0 ? `${integrity.data.pending_payable_events} payable event(s) are still waiting to be recorded.` : ''}</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs text-danger-fg">
              {integrity.data.violations.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          )
        ) : (
          <InlineProblem problem={integrity.problem} permission="payout:read_any" />
        )}
      </Card>
      {run && !isUuid(run) ? <Alert tone="warn">That run id is not valid.</Alert> : null}
      {result ? (
        result.ok ? (
          <ReconciliationResultView result={result.data} />
        ) : (
          <ProblemView problem={result.problem} permission="payout:read_any" what="this reconciliation run" />
        )
      ) : (
        <Card>
          <p className="text-sm text-fg-muted">Run a reconciliation to compare a period with the payout provider. The result opens here and can be shared by link. (The API does not list past runs, so keep the link of a run you want to revisit.)</p>
        </Card>
      )}
    </>
  );
}
