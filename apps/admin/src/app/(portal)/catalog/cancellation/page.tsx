import type { Metadata } from 'next';
import { Alert, ProblemView } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/layout';
import { NewCancellationVersionButton } from '@/features/catalog/components/cancellation-form';
import { CancellationGroups } from '@/features/catalog/components/rule-groups';
import { getScopeOptions } from '@/features/catalog/server';
import type { CancellationPolicy } from '@/features/catalog/types';
import { serverApi } from '@/lib/server/api';
import { serverNow } from '@/lib/server/clock';

export const metadata: Metadata = { title: 'Cancellation policies' };

export default async function CancellationPage() {
  const [res, options] = await Promise.all([serverApi<CancellationPolicy[]>('/admin/cancellation-policies'), getScopeOptions()]);
  return (
    <>
      <PageHeader title="Cancellation policies" description="How much of a booking is refunded when it is cancelled, by how much notice the customer gave, plus no-show and provider-cancel refunds." actions={<NewCancellationVersionButton options={options} existing={res.ok ? res.data : []} label="New policy or version" />} />
      <Alert tone="info" className="mb-5" title="Policies are versioned, never edited">
        Creating a version closes the one in force at the new version&apos;s effective time and opens the next. Bookings keep the policy that applied when they were requested. The effective time can be now or in the future, never in the past.
      </Alert>
      <Alert tone="warn" className="mb-5" title="Refund tiers are not shown in this list">
        The API&apos;s list endpoint returns each version&apos;s name, no-show and provider-cancel refunds and dates, but not its refund tiers. You can create a new version with full tiers; reviewing the tiers of an existing version needs an API change.
      </Alert>
      {res.ok ? <CancellationGroups policies={res.data} options={options} now={serverNow()} /> : <ProblemView problem={res.problem} permission="pricing:read" what="cancellation policies" retryHref="/catalog/cancellation" />}
    </>
  );
}
