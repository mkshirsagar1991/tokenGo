import type { Metadata } from 'next';
import { ProblemView } from '@/components/ui/feedback';
import { FilterBar, SelectField, TextField } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { PayablesTable } from '@/features/payouts/components/payout-tables';
import { PAYABLE_STATUSES, type Payable } from '@/features/payouts/types';
import { getProviderNames } from '@/features/providers/server';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { humanize } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Payables' };

export default async function PayablesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const [res, names] = await Promise.all([serverApi<Payable[], PageMeta>('/admin/payables', { query: { ...pick(sp, ['status', 'provider_id', 'cursor']), limit: 30 } }), getProviderNames()]);
  return (
    <>
      <PageHeader title="Payables" description="What the platform owes providers. A payable is a liability on the ledger, not money in a provider's bank: it becomes IN_PAYOUT when a transfer is requested and PAID when the bank confirms." />
      <FilterBar action="/payouts/payables">
        <SelectField label="Status" name="status" defaultValue={param(sp, 'status') ?? ''} placeholder="All statuses" options={PAYABLE_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} wrapperClassName="w-48" />
        <TextField label="Provider id" name="provider_id" defaultValue={param(sp, 'provider_id') ?? ''} placeholder="Provider UUID" spellCheck={false} wrapperClassName="w-72" className="font-mono text-xs" />
      </FilterBar>
      {res.ok ? (
        <>
          <PayablesTable payables={res.data} names={names} />
          <Pager basePath="/payouts/payables" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
        </>
      ) : (
        <ProblemView problem={res.problem} permission="payout:read_any" what="payables" retryHref="/payouts/payables" />
      )}
    </>
  );
}
