import type { Metadata } from 'next';
import { Badge, StatusBadge, Alert } from '@/components/ui/feedback';
import { IdChip } from '@/components/ui/id';
import { ProblemView } from '@/components/ui/feedback';
import { Card, DescriptionList, PageHeader } from '@/components/ui/layout';
import { TBody, TD, TH, THead, TR, TableCard } from '@/components/ui/table';
import { HoldControl } from '@/features/payouts/components/hold-controls';
import { RefreshPayoutButton } from '@/features/payouts/components/refresh-payout';
import type { PayoutDetail, PayoutHold } from '@/features/payouts/types';
import { ProviderLink } from '@/features/providers/components/provider-link';
import { getProviderNames } from '@/features/providers/server';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Payout' };

export default async function PayoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [res, holds, names] = await Promise.all([serverApi<PayoutDetail>(`/admin/payouts/${id}`), serverApi<PayoutHold[]>('/admin/payouts/holds'), getProviderNames()]);
  if (!res.ok) return <ProblemView problem={res.problem} permission="payout:read_any" what="this payout" retryHref={`/payouts/${id}`} />;
  const p = res.data;
  const frozen = holds.ok && holds.data.some((h) => h.provider_id === p.provider_id);
  return (
    <>
      <PageHeader
        back={{ href: '/payouts', label: 'All payouts' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {formatMoney(p.amount)} <StatusBadge status={p.status} />
            {p.needs_review ? <Badge tone="danger">Needs review</Badge> : null}
          </span>
        }
        description={<>Payout <code className="font-mono text-xs">{p.id}</code></>}
        actions={<RefreshPayoutButton payoutId={p.id} status={p.status} />}
      />
      {p.needs_review ? (
        <Alert tone="danger" title="This payout needs a person to look at it" className="mb-4">
          The payout provider&apos;s answer contradicted our records (for example “paid” for a payout we had failed, or a different amount). Nothing was corrected automatically and the provider&apos;s payouts were paused. Compare with the payout provider&apos;s dashboard before doing anything else.
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Transfer">
          <DescriptionList
            items={[
              { label: 'Amount', value: formatMoney(p.amount) },
              { label: 'Status', value: <StatusBadge status={p.status} /> },
              { label: 'Created', value: formatDateTime(p.created_at) },
              { label: 'Submitted to provider', value: formatDateTime(p.submitted_at) },
              { label: 'Completed', value: formatDateTime(p.completed_at) },
              { label: 'Bank reference (UTR)', value: p.utr ?? '—' },
              { label: 'Payout provider', value: p.provider ?? '—' },
              { label: 'Our reference', value: <code className="font-mono text-xs">{p.reference ?? '—'}</code> },
              { label: 'Provider’s id', value: <code className="font-mono text-xs">{p.provider_payout_id ?? '—'}</code> },
              { label: 'Attempts', value: p.attempts },
            ]}
          />
          {p.failure_reason ? <Alert tone="danger" className="mt-4" title="Failure reason">{p.failure_reason}</Alert> : null}
          {p.last_error ? <Alert tone="warn" className="mt-4" title="Last error (not final)">{p.last_error}</Alert> : null}
        </Card>
        <Card title="Provider (salon)" actions={<HoldControl providerId={p.provider_id} providerName={names.get(p.provider_id)} frozen={frozen} />}>
          <p className="text-sm">
            <ProviderLink id={p.provider_id} names={names} />
          </p>
          <p className="mt-2 text-sm text-fg-muted">{frozen ? 'This provider’s payouts are currently FROZEN.' : 'Payouts for this provider are not frozen.'}</p>
        </Card>
      </div>
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-fg-subtle">Payables in this payout</h2>
      <TableCard caption="Payables paid by this payout">
        <THead>
          <tr>
            <TH stickyFirst>Booking</TH>
            <TH>Payable</TH>
            <TH align="right">Net</TH>
          </tr>
        </THead>
        <TBody>
          {p.items.map((i) => (
            <TR key={i.payable_id}>
              <TD stickyFirst>
                <IdChip id={i.booking_id} label="booking id" />
              </TD>
              <TD>
                <IdChip id={i.payable_id} label="payable id" />
              </TD>
              <TD align="right" className="font-medium">{formatMoney(i.net)}</TD>
            </TR>
          ))}
        </TBody>
      </TableCard>
    </>
  );
}
