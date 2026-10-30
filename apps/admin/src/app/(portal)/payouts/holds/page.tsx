import type { Metadata } from 'next';
import { ProblemView } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/layout';
import { HoldsTable } from '@/features/payouts/components/payout-tables';
import { FreezeByIdButton } from '@/features/payouts/components/hold-controls';
import type { PayoutHold } from '@/features/payouts/types';
import { getProviderNames } from '@/features/providers/server';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Payout holds' };

export default async function HoldsPage() {
  const [res, names] = await Promise.all([serverApi<PayoutHold[]>('/admin/payouts/holds'), getProviderNames()]);
  return (
    <>
      <PageHeader title="Payout holds" description="Providers whose payouts are frozen. A hold is placed by an operator, or automatically after repeated payout failures or a contradictory provider answer." actions={<FreezeByIdButton />} />
      {res.ok ? <HoldsTable holds={res.data} names={names} /> : <ProblemView problem={res.problem} permission="payout:read_any" what="payout holds" retryHref="/payouts/holds" />}
    </>
  );
}
