import type { Metadata } from 'next';
import { Alert, ProblemView } from '@/components/ui/feedback';
import { LinkButton } from '@/components/ui/button';
import { FilterBar, SelectField, TextField } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { RefundsTable } from '@/features/payments/components/payments-tables';
import { REFUND_STATUSES, type Refund } from '@/features/payments/types';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { humanize } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Refunds' };

export default async function RefundsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const res = await serverApi<Refund[], PageMeta>('/admin/payments/refunds', { query: { ...pick(sp, ['status', 'payment_transaction_id', 'cursor']), limit: 30 } });
  return (
    <>
      <PageHeader title="Refunds" description="Money returned to a customer's original payment method. It leaves their wallet immediately; if the provider refuses it, it is returned to the wallet." actions={<LinkButton href="/payments/transactions?status=CAPTURED" variant="secondary">New refund: choose a payment</LinkButton>} />
      <Alert tone="info" className="mb-4">To refund, open a captured payment on the Transactions page and use “Refund…”. The amount can never exceed what remains refundable on that payment.</Alert>
      <FilterBar action="/payments/refunds">
        <SelectField label="Status" name="status" defaultValue={param(sp, 'status') ?? ''} placeholder="All statuses" options={REFUND_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} wrapperClassName="w-52" />
        <TextField label="Payment transaction id" name="payment_transaction_id" defaultValue={param(sp, 'payment_transaction_id') ?? ''} placeholder="Payment UUID" spellCheck={false} wrapperClassName="w-72" className="font-mono text-xs" />
      </FilterBar>
      {res.ok ? (
        <>
          <RefundsTable rows={res.data} />
          <Pager basePath="/payments/refunds" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
        </>
      ) : (
        <ProblemView problem={res.problem} permission="payments:read" what="refunds" retryHref="/payments/refunds" />
      )}
    </>
  );
}
