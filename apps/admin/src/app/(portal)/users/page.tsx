import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, ProblemView, StatusBadge } from '@/components/ui/feedback';
import { FilterBar, SelectField, TextField } from '@/components/ui/form';
import { IdChip } from '@/components/ui/id';
import { PageHeader } from '@/components/ui/layout';
import { Pager } from '@/components/ui/pager';
import { TBody, TD, TH, THead, TR, TableCard, TableEmpty } from '@/components/ui/table';
import { USER_STATUSES, type RoleDefinition, type UserView } from '@/features/users/types';
import { param, pick, type PageMeta, type SearchParams } from '@/lib/api-types';
import { formatDateTime, humanize } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Users' };

export default async function UsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const [res, roles] = await Promise.all([serverApi<UserView[], PageMeta>('/admin/users', { query: { ...pick(sp, ['query', 'status', 'role', 'cursor']), limit: 25 } }), serverApi<RoleDefinition[]>('/admin/roles')]);
  return (
    <>
      <PageHeader title="Users" description="Customer, provider and staff accounts. Phone numbers are always shown masked." />
      <FilterBar action="/users">
        <TextField label="User id or full phone number" name="query" defaultValue={param(sp, 'query') ?? ''} placeholder="e.g. 9876543210 or a user UUID" wrapperClassName="w-80" hint="Exact match only. There is no partial search by design: it would let anyone enumerate customers." />
        <SelectField label="Status" name="status" defaultValue={param(sp, 'status') ?? ''} placeholder="All statuses" options={USER_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} wrapperClassName="w-44" />
        <SelectField label="Role" name="role" defaultValue={param(sp, 'role') ?? ''} placeholder="Any role" options={roles.ok ? roles.data.map((r) => ({ value: r.code, label: r.name })) : []} wrapperClassName="w-60" />
      </FilterBar>
      {res.ok ? (
        <>
          <TableCard caption="Users">
            <THead>
              <tr>
                <TH stickyFirst>Account</TH>
                <TH>Status</TH>
                <TH>Roles</TH>
                <TH>Last sign-in</TH>
                <TH>Created</TH>
                <TH>Id</TH>
              </tr>
            </THead>
            <TBody>
              {res.data.length === 0 ? (
                <TableEmpty colSpan={6}>No users match. Remember that a phone number must be entered in full.</TableEmpty>
              ) : (
                res.data.map((u) => (
                  <TR key={u.id}>
                    <TD stickyFirst className="whitespace-nowrap">
                      <Link href={`/users/${u.id}`} className="font-medium text-brand-soft-fg hover:underline">
                        {u.phone_masked}
                      </Link>
                      {u.is_admin_account ? <Badge tone="brand" className="ml-2">Admin account</Badge> : null}
                    </TD>
                    <TD>
                      <StatusBadge status={u.status} />
                    </TD>
                    <TD>
                      <div className="flex max-w-sm flex-wrap gap-1">
                        {u.roles.map((r) => (
                          <Badge key={`${r.code}-${r.scope_id}`} title={r.scope_id ?? 'Platform-wide'}>{r.code}</Badge>
                        ))}
                      </div>
                    </TD>
                    <TD className="whitespace-nowrap">{formatDateTime(u.last_login_at)}</TD>
                    <TD className="whitespace-nowrap">{formatDateTime(u.created_at)}</TD>
                    <TD>
                      <IdChip id={u.id} label="user id" />
                    </TD>
                  </TR>
                ))
              )}
            </TBody>
          </TableCard>
          <Pager basePath="/users" searchParams={sp} nextCursor={res.meta?.next_cursor} shown={res.data.length} />
        </>
      ) : (
        <ProblemView problem={res.problem} permission="user:read_any" what="users" retryHref="/users" />
      )}
    </>
  );
}
