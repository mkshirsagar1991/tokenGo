import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, ProblemView } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/layout';
import { NAV } from '@/config/navigation';
import { PERMISSIONS, describePermission, hasAny } from '@/lib/permissions';
import { getMe } from '@/lib/server/api';

export const metadata: Metadata = { title: 'My access' };

export default async function AccountPage() {
  const me = await getMe();
  if (!me.ok) return <ProblemView problem={me.problem} />;
  const granted = me.data.permissions;
  const known = Object.keys(PERMISSIONS);
  const other = granted.filter((p) => !known.includes(p));
  return (
    <>
      <PageHeader title="My access" description={<>Signed in as {me.data.phone_masked}. These are the permissions your roles grant right now. The server checks them on every request; the menu merely hides what you cannot use.</>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Permissions you hold" description={`${granted.length} permission(s)`}>
          {granted.length === 0 ? (
            <Alert tone="warn">You have no permissions. Ask a platform administrator for a role.</Alert>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {granted.map((p) => (
                <li key={p}>
                  <code className="font-mono text-xs text-fg">{p}</code> <span className="text-fg-muted">{describePermission(p) !== p ? describePermission(p) : ''}</span>
                </li>
              ))}
            </ul>
          )}
          {other.length > 0 ? <p className="mt-3 text-xs text-fg-subtle">{other.length} of these are for areas the portal does not show yet (for example provider or customer permissions).</p> : null}
        </Card>
        <Card title="What you can open" description="Pages and the permission each needs.">
          <ul className="space-y-2 text-sm">
            {NAV.flatMap((g) => g.items).map((i) => {
              const ok = hasAny(granted, i.anyOf);
              return (
                <li key={i.href} className="flex flex-wrap items-center justify-between gap-2">
                  {ok ? <Link href={i.href} className="text-brand-soft-fg hover:underline">{i.label}</Link> : <span className="text-fg-subtle">{i.label}</span>}
                  {ok ? <Badge tone="success">Allowed</Badge> : <Badge title={`Needs ${i.anyOf.join(' or ')}`}>Needs {i.anyOf.join(' or ')}</Badge>}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
