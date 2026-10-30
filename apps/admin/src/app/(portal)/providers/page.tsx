import type { Metadata } from 'next';
import { ProblemView } from '@/components/ui/feedback';
import { FilterBar, SelectField } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { ProvidersTable } from '@/features/providers/components/providers-table';
import { PROVIDER_STATUSES, type Provider } from '@/features/providers/types';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { humanize } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Providers' };

export default async function ProvidersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const res = await serverApi<Provider[], PageMeta>('/admin/providers', { query: { ...pick(sp, ['status', 'cursor']), limit: 100 } });
  return (
    <>
      <PageHeader title="Providers" description="Businesses that registered to offer services. Only an approved provider can be booked or paid." />
      <FilterBar action="/providers">
        <SelectField label="Status" name="status" defaultValue={param(sp, 'status') ?? ''} placeholder="All statuses" options={PROVIDER_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} wrapperClassName="w-56" />
      </FilterBar>
      {res.ok ? (
        <>
          <ProvidersTable providers={res.data} />
          <Pager basePath="/providers" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
        </>
      ) : (
        <ProblemView problem={res.problem} permission="provider:read_any" what="providers" retryHref="/providers" />
      )}
    </>
  );
}
