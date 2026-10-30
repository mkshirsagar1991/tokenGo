import type { Metadata } from 'next';
import { ProblemView } from '@/components/ui/feedback';
import { FilterBar, SelectField, TextField } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { AccountsTable } from '@/features/payouts/components/payout-tables';
import { ACCOUNT_STATUSES, type PayoutAccount } from '@/features/payouts/types';
import { getProviderNames } from '@/features/providers/server';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { humanize } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Bank accounts' };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const [res, names] = await Promise.all([serverApi<PayoutAccount[], PageMeta>('/admin/payout-accounts', { query: { ...pick(sp, ['status', 'provider_id', 'cursor']), limit: 30 } }), getProviderNames()]);
  return (
    <>
      <PageHeader title="Provider bank accounts" description="Payout destinations. Account numbers are always masked: the full number cannot be read back through any endpoint. A new account replaces the old one and must pass a bank check (including a name match) and a cooling-off period before it can be paid." />
      <FilterBar action="/payouts/accounts">
        <SelectField label="Status" name="status" defaultValue={param(sp, 'status') ?? ''} placeholder="All statuses" options={ACCOUNT_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} wrapperClassName="w-56" />
        <TextField label="Provider id" name="provider_id" defaultValue={param(sp, 'provider_id') ?? ''} placeholder="Provider UUID" spellCheck={false} wrapperClassName="w-72" className="font-mono text-xs" />
      </FilterBar>
      {res.ok ? (
        <>
          <AccountsTable accounts={res.data} names={names} />
          <Pager basePath="/payouts/accounts" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
        </>
      ) : (
        <ProblemView problem={res.problem} permission="payout:read_any" what="bank accounts" retryHref="/payouts/accounts" />
      )}
    </>
  );
}
