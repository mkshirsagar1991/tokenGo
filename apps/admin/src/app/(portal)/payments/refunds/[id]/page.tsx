import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, ProblemView, StatusBadge } from '@/components/ui/feedback';
import { Card, DescriptionList, PageHeader } from '@/components/ui/layout';
import { RefundsTable } from '@/features/payments/components/payments-tables';
import type { Refund } from '@/features/payments/types';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import type { PageMeta } from '@/lib/api-types';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Refund' };

const STATUS_HELP: Record<string, string> = {
  PROCESSING: 'The money has left the customer’s wallet and is being sent back by the payment provider. It will complete or be reversed automatically.',
  SUCCEEDED: 'The provider confirmed the refund to the customer’s original payment method.',
  FAILED: 'The provider refused or failed the refund. The money was returned to the customer’s wallet.',
};

export default async function RefundDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await serverApi<Refund>(`/admin/payments/refunds/${id}`);
  if (!res.ok) return <ProblemView problem={res.problem} permission="payments:read" what="this refund" retryHref={`/payments/refunds/${id}`} />;
  const r = res.data;
  const siblings = await serverApi<Refund[], PageMeta>('/admin/payments/refunds', { query: { payment_transaction_id: r.payment_transaction_id, limit: 20 } });
  return (
    <>
      <PageHeader back={{ href: '/payments/refunds', label: 'All refunds' }} title={<span className="flex flex-wrap items-center gap-3">{formatMoney(r.amount)} <StatusBadge status={r.status} /></span>} description={<>Refund <code className="font-mono text-xs">{r.id}</code></>} />
      <Alert tone={r.status === 'FAILED' ? 'warn' : r.status === 'SUCCEEDED' ? 'success' : 'info'} className="mb-4">
        {STATUS_HELP[r.status]}
      </Alert>
      <Card title="Details">
        <DescriptionList
          items={[
            { label: 'Amount', value: formatMoney(r.amount) },
            { label: 'Status', value: <StatusBadge status={r.status} /> },
            { label: 'Reason given', value: r.reason },
            { label: 'Failure reason', value: r.failure_reason ?? '—' },
            { label: 'Requested', value: formatDateTime(r.created_at) },
            { label: 'Last updated', value: formatDateTime(r.updated_at) },
            { label: 'Payment transaction', value: <Link className="font-mono text-xs text-brand-soft-fg hover:underline" href={`/payments/refunds?payment_transaction_id=${r.payment_transaction_id}`}>{r.payment_transaction_id}</Link> },
          ]}
        />
      </Card>
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-fg-subtle">All refunds of the same payment</h2>
      {siblings.ok ? <RefundsTable rows={siblings.data} /> : null}
    </>
  );
}
