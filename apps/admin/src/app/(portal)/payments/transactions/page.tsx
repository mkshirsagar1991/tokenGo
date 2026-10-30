import type { Metadata } from 'next';
import { ProblemView } from '@/components/ui/feedback';
import { FilterBar, SelectField, TextField } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { TransactionsTable } from '@/features/payments/components/payments-tables';
import { TX_STATUSES, type PaymentTransaction } from '@/features/payments/types';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { humanize } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Payment transactions' };

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const res = await serverApi<PaymentTransaction[], PageMeta>('/admin/payments/transactions', { query: { ...pick(sp, ['status', 'customer_id', 'cursor']), limit: 30 } });
  return (
    <>
      <PageHeader title="Payment transactions" description="Customer top-ups as the payment provider reported them. Only a captured payment is money; a quarantined one was captured but did not match what we expected and was not credited." />
      <FilterBar action="/payments/transactions">
        <SelectField label="Status" name="status" defaultValue={param(sp, 'status') ?? ''} placeholder="All statuses" options={TX_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} wrapperClassName="w-52" />
        <TextField label="Customer id" name="customer_id" defaultValue={param(sp, 'customer_id') ?? ''} placeholder="Customer UUID" spellCheck={false} wrapperClassName="w-72" className="font-mono text-xs" />
      </FilterBar>
      {res.ok ? (
        <>
          <TransactionsTable rows={res.data} />
          <Pager basePath="/payments/transactions" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
        </>
      ) : (
        <ProblemView problem={res.problem} permission="payments:read" what="payment transactions" retryHref="/payments/transactions" />
      )}
    </>
  );
}
