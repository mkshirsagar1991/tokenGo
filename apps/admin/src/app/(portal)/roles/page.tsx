import type { Metadata } from 'next';
import { Badge, ProblemView } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/layout';
import { SCOPE_HELP, type RoleDefinition } from '@/features/users/types';
import { describePermission } from '@/lib/permissions';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Roles' };

export default async function RolesPage() {
  const res = await serverApi<RoleDefinition[]>('/admin/roles');
  return (
    <>
      <PageHeader title="Roles" description="What each role can do. Roles are fixed bundles of permissions; they are granted per account on the user's page. The server checks the permission on every request." />
      {res.ok ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {res.data.map((r) => (
            <Card key={r.code} title={r.name} description={<><code className="font-mono">{r.code}</code> · {SCOPE_HELP[r.scope_type]}</>} actions={r.requires_mfa ? <Badge tone="info">Requires two-factor</Badge> : <Badge>No two-factor needed</Badge>}>
              {r.permissions.length === 0 ? (
                <p className="text-sm text-fg-muted">No permissions.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {r.permissions.map((p) => (
                    <li key={p} className="flex flex-wrap gap-x-2">
                      <code className="font-mono text-xs text-fg">{p}</code>
                      <span className="text-fg-muted">{describePermission(p) !== p ? describePermission(p) : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      ) : (
        <ProblemView problem={res.problem} permission="role:read" what="roles" retryHref="/roles" />
      )}
    </>
  );
}
