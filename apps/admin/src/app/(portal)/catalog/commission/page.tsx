import type { Metadata } from 'next';
import { Alert, ProblemView } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/layout';
import { NewCommissionVersionButton } from '@/features/catalog/components/commission-form';
import { CommissionGroups } from '@/features/catalog/components/rule-groups';
import { getScopeOptions } from '@/features/catalog/server';
import type { CommissionRule } from '@/features/catalog/types';
import { serverApi } from '@/lib/server/api';
import { serverNow } from '@/lib/server/clock';

export const metadata: Metadata = { title: 'Commission rules' };

export default async function CommissionPage() {
  const [res, options] = await Promise.all([serverApi<CommissionRule[]>('/admin/commission-rules'), getScopeOptions()]);
  return (
    <>
      <PageHeader title="Commission rules" description="What the platform keeps from each completed booking. A more specific rule (provider, service) overrides a broader one (category, platform)." actions={<NewCommissionVersionButton options={options} existing={res.ok ? res.data : []} label="New rule or version" />} />
      <Alert tone="info" className="mb-5" title="Rules are versioned, never edited">
        Creating a version closes the one in force at the new version&apos;s effective time and opens the next. Bookings keep the commission that applied when they were requested, so history is always consistent. The effective time can be now or in the future, never in the past.
      </Alert>
      {res.ok ? <CommissionGroups rules={res.data} options={options} now={serverNow()} /> : <ProblemView problem={res.problem} permission="pricing:read" what="commission rules" retryHref="/catalog/commission" />}
    </>
  );
}
