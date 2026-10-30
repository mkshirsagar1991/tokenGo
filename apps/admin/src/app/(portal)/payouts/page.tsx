import type { Metadata } from 'next';
import { ProblemView } from '@/components/ui/feedback';
import { FilterBar, SelectField, TextField } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { PayoutsTable } from '@/features/payouts/components/payout-tables';
import { RunBatchButton } from '@/features/payouts/components/run-batch';
import { PAYOUT_STATUSES, type Payout } from '@/features/payouts/types';
import { getProviderNames } from '@/features/providers/server';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { humanize } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Payouts' };

export default async function PayoutsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const [res, names] = await Promise.all([serverApi<Payout[], PageMeta>('/admin/payouts', { query: { ...pick(sp, ['status', 'provider_id', 'needs_review', 'cursor']), limit: 30 } }), getProviderNames()]);
  return (
    <>
      <PageHeader title="Payouts" description="Bank transfers to providers. Money moves RESERVED → SUBMITTED → PAID; a failed payout is reversed and retried as a new one." actions={<RunBatchButton />} />
      <FilterBar action="/payouts">
        <SelectField label="Status" name="status" defaultValue={param(sp, 'status') ?? ''} placeholder="All statuses" options={PAYOUT_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} wrapperClassName="w-48" />
        <SelectField label="Review" name="needs_review" defaultValue={param(sp, 'needs_review') ?? ''} placeholder="Any" options={[{ value: 'true', label: 'Needs review only' }]} wrapperClassName="w-48" />
        <TextField label="Provider id" name="provider_id" defaultValue={param(sp, 'provider_id') ?? ''} placeholder="Provider UUID" spellCheck={false} wrapperClassName="w-72" className="font-mono text-xs" />
      </FilterBar>
      {res.ok ? (
        <>
          <PayoutsTable payouts={res.data} names={names} />
          <Pager basePath="/payouts" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
        </>
      ) : (
        <ProblemView problem={res.problem} permission="payout:read_any" what="payouts" retryHref="/payouts" />
      )}
    </>
  );
}
