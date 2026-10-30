import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, InlineProblem, ProblemView, StatusBadge } from '@/components/ui/feedback';
import { Card, DescriptionList, PageHeader } from '@/components/ui/layout';
import { AuditTable } from '@/features/audit/components/audit-table';
import type { AuditEvent } from '@/features/audit/types';
import { RoleManager, SuspendControls } from '@/features/users/components/user-actions';
import type { RoleDefinition, UserView } from '@/features/users/types';
import type { PageMeta } from '@/lib/api-types';
import { formatDateTime, humanize, isUuid } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'User' };

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return <ProblemView problem={{ status: 404, code: 'NOT_FOUND', detail: 'That is not a valid user id.' }} />;
  const [res, roles, audit] = await Promise.all([
    serverApi<UserView>(`/admin/users/${id}`),
    serverApi<RoleDefinition[]>('/admin/roles'),
    serverApi<AuditEvent[], PageMeta>('/admin/audit-logs', { query: { entity_type: 'user', entity_id: id, limit: 20 } }),
  ]);
  if (!res.ok) return <ProblemView problem={res.problem} permission="user:read_any" what="this user" retryHref={`/users/${id}`} />;
  const u = res.data;
  return (
    <>
      <PageHeader back={{ href: '/users', label: 'All users' }} title={<span className="flex flex-wrap items-center gap-3">{u.phone_masked} <StatusBadge status={u.status} />{u.is_admin_account ? <Badge tone="brand">Admin account</Badge> : null}</span>} description={<>User <code className="font-mono text-xs">{u.id}</code></>} />
      {u.deletion_scheduled_for ? (
        <Alert tone="warn" className="mb-4" title="Account deletion scheduled">
          The person asked to delete this account; it will be anonymised on {formatDateTime(u.deletion_scheduled_for)} unless they cancel.
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Account">
          <DescriptionList
            items={[
              { label: 'Status', value: humanize(u.status) },
              { label: 'Active sessions', value: u.active_sessions ?? '—' },
              { label: 'Created', value: formatDateTime(u.created_at) },
              { label: 'Last sign-in', value: formatDateTime(u.last_login_at) },
            ]}
          />
          <div className="mt-4 border-t border-line pt-4">
            <SuspendControls user={u} />
          </div>
        </Card>
        <Card title="Roles" description="What this account may do. Platform staff roles require two-factor authentication.">
          <RoleManager user={u} roles={roles.ok ? roles.data : null} />
          {!roles.ok ? <div className="mt-3"><InlineProblem problem={roles.problem} permission="role:read" /></div> : null}
        </Card>
      </div>
      <h2 className="mb-1 mt-8 text-sm font-semibold uppercase tracking-wide text-fg-subtle">Account history (audit log)</h2>
      <p className="mb-3 text-xs text-fg-subtle">Suspensions, reinstatements and role changes, with who did them and why.</p>
      {audit.ok ? (
        <>
          <AuditTable events={audit.data} caption="Audit events for this user" showEntity={false} emptyText="No audit events for this account." />
          <p className="mt-2 text-sm"><Link href={`/audit?entity_type=user&entity_id=${id}`} className="text-brand-soft-fg hover:underline">Open in the audit log →</Link></p>
        </>
      ) : (
        <InlineProblem problem={audit.problem} permission="audit:read" />
      )}
    </>
  );
}
