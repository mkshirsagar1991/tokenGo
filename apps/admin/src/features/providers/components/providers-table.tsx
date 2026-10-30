'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { IdChip } from '@/components/ui/id';
import { StatusBadge } from '@/components/ui/feedback';
import { TBody, TD, TH, THead, TR, TableCard, TableEmpty } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import type { Provider } from '../types';

/** The API has no text search for providers, so this filters the page that was loaded (and says so). */
export function ProvidersTable({ providers }: { providers: Provider[] }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return providers;
    return providers.filter((p) => p.display_name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle) || (p.description ?? '').toLowerCase().includes(needle));
  }, [providers, q]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm font-medium text-fg">
          Search this page
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, id or description" className="h-10 rounded-lg border border-line bg-surface px-3 text-sm font-normal text-fg placeholder:text-fg-subtle" />
        </label>
        <p className="max-w-md text-xs text-fg-subtle">Searches only the {providers.length} providers loaded below; the API does not offer server-side search yet. Use the status filter and “Next page” to move through all providers.</p>
      </div>
      <TableCard caption="Providers">
        <THead>
          <tr>
            <TH stickyFirst>Provider</TH>
            <TH>Status</TH>
            <TH>Submitted</TH>
            <TH>Decided</TH>
            <TH>Id</TH>
          </tr>
        </THead>
        <TBody>
          {rows.length === 0 ? (
            <TableEmpty colSpan={5}>{providers.length === 0 ? 'No providers match these filters.' : 'No provider on this page matches your search.'}</TableEmpty>
          ) : (
            rows.map((p) => (
              <TR key={p.id}>
                <TD stickyFirst>
                  <Link href={`/providers/${p.id}`} className="font-medium text-brand-soft-fg hover:underline">
                    {p.display_name}
                  </Link>
                  {p.description ? <p className="max-w-xs truncate text-xs text-fg-subtle">{p.description}</p> : null}
                </TD>
                <TD>
                  <StatusBadge status={p.status} />
                </TD>
                <TD className="whitespace-nowrap">{formatDateTime(p.submitted_at)}</TD>
                <TD className="whitespace-nowrap">{formatDateTime(p.decided_at)}</TD>
                <TD>
                  <IdChip id={p.id} label="provider id" />
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </TableCard>
    </div>
  );
}
