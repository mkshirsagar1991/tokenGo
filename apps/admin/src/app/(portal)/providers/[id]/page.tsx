import type { Metadata } from 'next';
import Link from 'next/link';
import { InlineProblem, ProblemView, StatusBadge } from '@/components/ui/feedback';
import { Card, DescriptionList, PageHeader } from '@/components/ui/layout';
import { AuditTable } from '@/features/audit/components/audit-table';
import type { AuditEvent } from '@/features/audit/types';
import { HoldControl } from '@/features/payouts/components/hold-controls';
import { AccountsTable, PayoutsTable } from '@/features/payouts/components/payout-tables';
import type { Payout, PayoutAccount, PayoutHold } from '@/features/payouts/types';
import { ProviderActions } from '@/features/providers/components/provider-actions';
import type { Provider } from '@/features/providers/types';
import { isUuid } from '@/lib/format';
import { formatDateTime } from '@/lib/format';
import type { PageMeta } from '@/lib/api-types';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Provider' };

export default async function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return <ProblemView problem={{ status: 404, code: 'NOT_FOUND', detail: 'That is not a valid provider id.' }} />;

  const [res, audit, accounts, payouts, holds] = await Promise.all([
    serverApi<Provider>(`/admin/providers/${id}`),
    serverApi<AuditEvent[], PageMeta>('/admin/audit-logs', { query: { entity_type: 'provider', entity_id: id, limit: 25 } }),
    serverApi<PayoutAccount[], PageMeta>('/admin/payout-accounts', { query: { provider_id: id, limit: 10 } }),
    serverApi<Payout[], PageMeta>('/admin/payouts', { query: { provider_id: id, limit: 5 } }),
    serverApi<PayoutHold[]>('/admin/payouts/holds'),
  ]);
  if (!res.ok) return <ProblemView problem={res.problem} permission="provider:read_any" what="this provider" retryHref={`/providers/${id}`} />;
  const p = res.data;
  const hold = holds.ok ? holds.data.find((h) => h.provider_id === id) : undefined;
  const names = new Map([[id, p.display_name]]);

  return (
    <>
      <PageHeader back={{ href: '/providers', label: 'All providers' }} title={<span className="flex flex-wrap items-center gap-3">{p.display_name} <StatusBadge status={p.status} /></span>} description={p.description ?? 'No description.'} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Verification" description="Move the provider through review. Each action asks for confirmation and is audited.">
          <ProviderActions provider={p} />
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Decision summary</h3>
            <DescriptionList
              columns={1}
              items={[
                { label: 'Registered', value: formatDateTime(p.created_at) },
                { label: 'Submitted for verification', value: formatDateTime(p.submitted_at) },
                { label: 'Latest decision', value: p.decided_at ? `${formatDateTime(p.decided_at)}` : '—' },
                { label: 'Latest reason', value: p.decision_reason ? `“${p.decision_reason}”` : <span className="text-fg-subtle">None recorded</span> },
                { label: 'Record version', value: p.version },
              ]}
            />
          </div>
        </Card>

        <Card title="Payouts" description="Whether this provider can be paid, and where." actions={<HoldControl providerId={id} providerName={p.display_name} frozen={Boolean(hold)} />}>
          {holds.ok ? (
            hold ? (
              <p className="mb-3 rounded-lg bg-danger-soft p-3 text-sm text-danger-fg">
                <strong>Payouts are frozen</strong> since {formatDateTime(hold.since)} ({hold.automatic ? 'automatically' : 'by an operator'}): “{hold.reason}”
              </p>
            ) : (
              <p className="mb-3 text-sm text-fg-muted">Payouts are not frozen.</p>
            )
          ) : (
            <InlineProblem problem={holds.problem} permission="payout:read_any" />
          )}
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Bank account (masked)</h3>
          {accounts.ok ? <AccountsTable accounts={accounts.data} names={names} /> : <InlineProblem problem={accounts.problem} permission="payout:read_any" />}
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-fg-subtle">Recent payouts</h2>
      {payouts.ok ? (
        <>
          <PayoutsTable payouts={payouts.data} names={names} />
          <p className="mt-2 text-sm">
            <Link href={`/payouts?provider_id=${id}`} className="text-brand-soft-fg hover:underline">All payouts for this provider →</Link>{' · '}
            <Link href={`/payouts/payables?provider_id=${id}`} className="text-brand-soft-fg hover:underline">Payables →</Link>
          </p>
        </>
      ) : (
        <InlineProblem problem={payouts.problem} permission="payout:read_any" />
      )}

      <h2 className="mb-1 mt-8 text-sm font-semibold uppercase tracking-wide text-fg-subtle">Decision history (audit log)</h2>
      <p className="mb-3 text-xs text-fg-subtle">Every verification decision, who made it and the reason they gave.</p>
      {audit.ok ? (
        <>
          <AuditTable events={audit.data} caption="Audit events for this provider" showEntity={false} emptyText="No audit events recorded for this provider yet." />
          <p className="mt-2 text-sm"><Link href={`/audit?entity_type=provider&entity_id=${id}`} className="text-brand-soft-fg hover:underline">Open in the audit log →</Link></p>
        </>
      ) : (
        <InlineProblem problem={audit.problem} permission="audit:read" />
      )}
    </>
  );
}
