import Link from 'next/link';
import { Badge } from '@/components/ui/feedback';
import { IdChip } from '@/components/ui/id';
import { TBody, TD, TH, THead, TR, TableCard, TableEmpty } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import type { AuditEvent } from '../types';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function reasonOf(e: AuditEvent): string | null {
  return isRecord(e.metadata) && typeof e.metadata.reason === 'string' ? e.metadata.reason : null;
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || (isRecord(value) && Object.keys(value).length === 0)) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</p>
      <pre className="max-h-56 overflow-auto rounded-lg bg-surface-2 p-3 text-xs text-fg-muted">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** One row per audit event; the before/after/metadata snapshots (already sanitised by the API) open in place. */
export function AuditTable({ events, caption = 'Audit events', emptyText = 'No audit events match.', showEntity = true }: { events: AuditEvent[]; caption?: string; emptyText?: string; showEntity?: boolean }) {
  return (
    <TableCard caption={caption}>
      <THead>
        <tr>
          <TH stickyFirst>When</TH>
          <TH>Action</TH>
          <TH>Who</TH>
          {showEntity ? <TH>Subject</TH> : null}
          <TH>Detail</TH>
        </tr>
      </THead>
      <TBody>
        {events.length === 0 ? (
          <TableEmpty colSpan={showEntity ? 5 : 4}>{emptyText}</TableEmpty>
        ) : (
          events.map((e) => {
            const reason = reasonOf(e);
            return (
              <TR key={e.id}>
                <TD stickyFirst className="whitespace-nowrap">{formatDateTime(e.occurred_at)}</TD>
                <TD>
                  <Link href={`/audit?action=${encodeURIComponent(e.action)}`} className="hover:underline">
                    <Badge tone="brand">{e.action}</Badge>
                  </Link>
                </TD>
                <TD>
                  <div className="flex items-center gap-1.5">
                    <Badge>{e.actor_type}</Badge>
                    <IdChip id={e.actor_id} label="actor id" />
                  </div>
                </TD>
                {showEntity ? (
                  <TD>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-fg-muted">{e.entity_type}</span>
                      <IdChip id={e.entity_id} label="entity id" />
                    </div>
                  </TD>
                ) : null}
                <TD className="min-w-56">
                  {reason ? <p className="mb-1 text-sm text-fg">“{reason}”</p> : null}
                  <details>
                    <summary className="cursor-pointer text-xs text-brand-soft-fg">Snapshots</summary>
                    <div className="mt-2 space-y-2">
                      <Json label="Before" value={e.before} />
                      <Json label="After" value={e.after} />
                      <Json label="Metadata" value={e.metadata} />
                      {e.request_id ? <p className="text-xs text-fg-subtle">Request <code className="font-mono">{e.request_id}</code></p> : null}
                    </div>
                  </details>
                </TD>
              </TR>
            );
          })
        )}
      </TBody>
    </TableCard>
  );
}
