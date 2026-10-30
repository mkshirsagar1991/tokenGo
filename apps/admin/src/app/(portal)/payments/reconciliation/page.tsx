import type { Metadata } from 'next';
import { RunReconciliationButton } from '@/components/reconciliation/run-reconciliation';
import { ReconciliationResultView } from '@/components/reconciliation/reconciliation-result';
import type { ReconciliationResult } from '@/components/reconciliation/types';
import { Alert, ProblemView } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/layout';
import { param, type SearchParams } from '@/lib/api-types';
import { isUuid } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Payment reconciliation' };

export default async function PaymentReconciliationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const run = param(sp, 'run');
  const result = run && isUuid(run) ? await serverApi<ReconciliationResult>(`/admin/payments/reconciliation/${run}`) : null;
  return (
    <>
      <PageHeader title="Payment reconciliation" description="Compares our record of captured payments with the payment provider's for a period (up to 31 days). It also catches refunds made outside the system, for example in the provider's dashboard." actions={<RunReconciliationButton endpoint="/admin/payments/reconciliation" subject="payments" basePath="/payments/reconciliation" />} />
      {run && !isUuid(run) ? <Alert tone="warn" className="mb-4">That run id is not valid.</Alert> : null}
      {result ? (
        result.ok ? (
          <ReconciliationResultView result={result.data} />
        ) : (
          <ProblemView problem={result.problem} permission="payments:read" what="this reconciliation run" />
        )
      ) : (
        <Card>
          <p className="text-sm text-fg-muted">Run a reconciliation to compare a period with the provider. The result opens here and can be shared by link. (The API does not list past runs, so keep the link of a run you want to revisit.)</p>
        </Card>
      )}
    </>
  );
}
