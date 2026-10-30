import type { Metadata } from 'next';
import { Badge, ProblemView } from '@/components/ui/feedback';
import { FilterBar, SelectField } from '@/components/ui/form';
import { Card, PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { WebhooksTable } from '@/features/payments/components/payments-tables';
import { WEBHOOK_OUTCOMES, WEBHOOK_STATUSES, type WebhookEvent } from '@/features/payments/types';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { humanize } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Webhook events' };

export default async function WebhooksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const res = await serverApi<WebhookEvent[], PageMeta>('/admin/payments/webhook-events', { query: { ...pick(sp, ['status', 'cursor']), limit: 30 } });
  return (
    <>
      <PageHeader title="Webhook events" description="What the payment provider told us. The signature is checked on the raw body; the event is deduplicated by its provider id; and nothing is credited from a webhook body: the payment is fetched from the provider first." />
      <FilterBar action="/payments/webhooks">
        <SelectField label="State" name="status" defaultValue={param(sp, 'status') ?? ''} placeholder="All states" options={WEBHOOK_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} wrapperClassName="w-52" />
      </FilterBar>
      {res.ok ? (
        <>
          <WebhooksTable rows={res.data} />
          <Pager basePath="/payments/webhooks" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
          <details className="mt-6">
            <summary className="cursor-pointer text-sm font-medium text-fg-muted">What do the outcomes mean?</summary>
            <Card className="mt-2">
              <ul className="space-y-2 text-sm">
                <li>
                  <Badge tone="danger">Invalid signature</Badge> <span className="text-fg-muted">The request did not verify. It is kept only as evidence of abuse, with nothing taken from it.</span>
                </li>
                {Object.entries(WEBHOOK_OUTCOMES).map(([code, o]) => (
                  <li key={code}>
                    <Badge tone={o.tone}>{o.label}</Badge> <span className="text-fg-muted">{o.help}</span>
                  </li>
                ))}
                <li className="text-fg-muted">A webhook the provider re-sends with the same event id is recognised as a duplicate and acknowledged without creating another row here.</li>
              </ul>
            </Card>
          </details>
        </>
      ) : (
        <ProblemView problem={res.problem} permission="payments:read" what="webhook events" retryHref="/payments/webhooks" />
      )}
    </>
  );
}
