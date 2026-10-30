import type { Metadata } from 'next';
import Link from 'next/link';
import { ProblemView } from '@/components/ui/feedback';
import { FilterBar, TextField } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { AuditTable } from '@/features/audit/components/audit-table';
import { AUDIT_FILTER_KEYS, type AuditEvent } from '@/features/audit/types';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { istLocalToIso } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Audit log' };

const QUICK = ['admin.*', 'user.*', 'provider.*', 'pricing.*', 'catalog.*', 'refund.*', 'payout.*', 'payments.*', 'settings.*', 'auth.*'];

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const query = pick(sp, [...AUDIT_FILTER_KEYS, 'cursor']);
  // The date inputs are IST wall-clock values; the API takes ISO-8601 instants.
  for (const k of ['from', 'to'] as const) {
    if (query[k]) {
      const iso = istLocalToIso(query[k]);
      if (iso) query[k] = iso;
      else delete query[k];
    }
  }
  const res = await serverApi<AuditEvent[], PageMeta>('/admin/audit-logs', { query: { ...query, limit: 30 } });
  const qs = (action: string) => `/audit?action=${encodeURIComponent(action)}`;
  return (
    <>
      <PageHeader title="Audit log" description="An append-only record of sensitive actions: who did what, to which record, when, and why. Newest first. Credentials and personal data were removed before they were written." />
      <FilterBar action="/audit">
        <TextField label="Action" name="action" defaultValue={param(sp, 'action') ?? ''} placeholder="provider.approve or provider.*" hint="Exact name, or a prefix ending in .*" wrapperClassName="w-64" />
        <TextField label="Subject type" name="entity_type" defaultValue={param(sp, 'entity_type') ?? ''} placeholder="provider, user, setting…" wrapperClassName="w-44" />
        <TextField label="Subject id" name="entity_id" defaultValue={param(sp, 'entity_id') ?? ''} placeholder="Record id" spellCheck={false} wrapperClassName="w-72" className="font-mono text-xs" />
        <TextField label="Actor (user id)" name="actor_id" defaultValue={param(sp, 'actor_id') ?? ''} placeholder="User UUID" spellCheck={false} wrapperClassName="w-72" className="font-mono text-xs" />
        <TextField label="From (IST)" name="from" type="datetime-local" defaultValue={param(sp, 'from') ?? ''} wrapperClassName="w-52" />
        <TextField label="To (IST)" name="to" type="datetime-local" defaultValue={param(sp, 'to') ?? ''} wrapperClassName="w-52" />
      </FilterBar>
      <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-subtle">
        Quick filters:
        {QUICK.map((a) => (
          <Link key={a} href={qs(a)} className="rounded-full bg-surface-2 px-2.5 py-0.5 font-mono text-xs text-fg-muted hover:text-fg">
            {a}
          </Link>
        ))}
      </p>
      {res.ok ? (
        <>
          <AuditTable events={res.data} />
          <Pager basePath="/audit" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
        </>
      ) : (
        <ProblemView problem={res.problem} permission="audit:read" what="the audit log" retryHref="/audit" />
      )}
    </>
  );
}
