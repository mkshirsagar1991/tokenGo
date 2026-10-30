'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff, useCan, useSessionInfo } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, Badge } from '@/components/ui/feedback';
import { SelectField, TextField } from '@/components/ui/form';
import { isStaleProblem, toAction } from '@/lib/client/actions';
import { isUuid, shortId } from '@/lib/format';
import { isStaffRole, type RoleAssignment, type RoleDefinition, type UserView } from '../types';

const assignmentLabel = (a: RoleAssignment) => (a.scope_type === 'PLATFORM' ? a.code : `${a.code} @ ${a.scope_type.toLowerCase()} ${shortId(a.scope_id)}`);

export function SuspendControls({ user }: { user: UserView }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const { userId } = useSessionInfo();
  const [open, setOpen] = useState(false);
  if (!can('user:suspend')) return null;
  if (user.id === userId) return <Alert tone="info">You cannot suspend or change the roles of your own account. Ask another administrator.</Alert>;
  const suspending = user.status === 'ACTIVE';
  if (!suspending && user.status !== 'SUSPENDED') return <p className="text-sm text-fg-muted">An account that is {user.status.toLowerCase()} cannot be suspended or reinstated.</p>;

  return (
    <>
      <Button variant={suspending ? 'outline-danger' : 'primary'} onClick={() => setOpen(true)}>
        {suspending ? 'Suspend account' : 'Reinstate account'}
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title={suspending ? 'Suspend this account?' : 'Reinstate this account?'}
          description={`${user.phone_masked}`}
          effects={
            suspending
              ? ['The person cannot sign in or use the app, and every active session is ended immediately.', 'Roles and data are kept. Existing bookings and money are not touched by this action.', 'Your reason is recorded in the audit log.']
              : ['The person can sign in again with their normal login.', 'The action is recorded in the audit log. The API does not take a reason for reinstatement.']
          }
          confirmLabel={suspending ? 'Suspend account' : 'Reinstate account'}
          tone={suspending ? 'danger' : 'primary'}
          reason={suspending ? { min: 3, max: 500, placeholder: 'Why is this account being suspended?' } : undefined}
          onConfirm={async ({ reason }) => {
            const res = suspending ? await bff.post(`/admin/users/${user.id}/suspend`, { reason }) : await bff.post(`/admin/users/${user.id}/reinstate`);
            if (res.ok || isStaleProblem(res.problem.code)) router.refresh();
            return toAction(res, suspending ? 'Account suspended.' : 'Account reinstated.');
          }}
        />
      ) : null}
    </>
  );
}

export function RoleManager({ user, roles }: { user: UserView; roles: RoleDefinition[] | null }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const { userId } = useSessionInfo();
  const [grantOpen, setGrantOpen] = useState(false);
  const [revoke, setRevoke] = useState<RoleAssignment | null>(null);
  const [roleCode, setRoleCode] = useState('');
  const [scopeId, setScopeId] = useState('');
  const manage = can('role:assign');
  const self = user.id === userId;

  const role = roles?.find((r) => r.code === roleCode);
  const needsScopeId = role ? role.scope_type !== 'PLATFORM' : false;
  const notAdmin = role ? isStaffRole(role) && !user.is_admin_account : false;
  const scopeOk = !needsScopeId || isUuid(scopeId.trim());
  const alreadyHas = role ? user.roles.some((a) => a.code === role.code && (a.scope_id ?? '') === (needsScopeId ? scopeId.trim() : '')) : false;

  return (
    <>
      <ul className="mb-4 flex flex-wrap gap-2" aria-label="Current roles">
        {user.roles.length === 0 ? <li className="text-sm text-fg-muted">No roles.</li> : null}
        {user.roles.map((a) => (
          <li key={`${a.code}-${a.scope_type}-${a.scope_id}`} className="flex items-center gap-1 rounded-full bg-surface-2 py-1 pl-3 pr-1 text-sm">
            <span title={a.scope_id ?? 'Platform-wide'}>{assignmentLabel(a)}</span>
            {manage && !self ? (
              <Button size="sm" variant="ghost" aria-label={`Revoke ${assignmentLabel(a)}`} onClick={() => setRevoke(a)} className="h-6 px-2">
                Revoke
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {manage ? (
        self ? (
          <Alert tone="info">You cannot change your own roles. Ask another administrator.</Alert>
        ) : roles ? (
          <Button variant="secondary" onClick={() => { setRoleCode(''); setScopeId(''); setGrantOpen(true); }}>
            Grant a role…
          </Button>
        ) : (
          <Alert tone="warn">The role catalogue could not be loaded, so roles cannot be granted from here.</Alert>
        )
      ) : (
        <p className="text-sm text-fg-subtle">Your role does not include <code className="font-mono text-xs">role:assign</code>, so roles are read-only for you.</p>
      )}

      {grantOpen && roles ? (
        <ConfirmDialog
          open
          onClose={() => setGrantOpen(false)}
          title="Grant a role"
          description={`To ${user.phone_masked}`}
          effects={[
            role ? `${role.name} gives: ${role.permissions.length} permission(s). The person gets them immediately.` : 'Choose a role to see what it allows.',
            role && role.requires_mfa ? 'This role requires two-factor authentication; it only takes effect in a session that passed it.' : 'The grant is recorded in the audit log with your account.',
            'You cannot grant roles to yourself, and platform staff roles can only be granted to administrator accounts.',
          ]}
          confirmLabel="Grant role"
          canConfirm={Boolean(role) && scopeOk && !notAdmin && !alreadyHas}
          onConfirm={async () => {
            if (!role) return { ok: false, problem: { status: 422, code: 'VALIDATION_FAILED', detail: 'Choose a role.' } };
            const body: Record<string, unknown> = { role_code: role.code, scope_type: role.scope_type };
            if (needsScopeId) body.scope_id = scopeId.trim();
            const res = await bff.post(`/admin/users/${user.id}/roles`, body);
            if (res.ok || isStaleProblem(res.problem.code)) router.refresh();
            return toAction(res, 'Role granted.');
          }}
        >
          <div className="grid gap-3">
            <SelectField label="Role" value={roleCode} onChange={(e) => setRoleCode(e.target.value)} placeholder="Choose a role…" options={roles.map((r) => ({ value: r.code, label: `${r.name} (${r.scope_type.toLowerCase()})` }))} />
            {role && needsScopeId ? <TextField label={role.scope_type === 'PROVIDER' ? 'Provider id' : 'Location id'} value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="UUID" spellCheck={false} className="font-mono text-xs" error={scopeId && !scopeOk ? 'Enter a valid UUID.' : undefined} /> : null}
            {notAdmin ? <Alert tone="warn" title="Not an administrator account">Platform staff roles can only be given to an account created with the admin tooling (it has a password and two-factor). The API will refuse this (NOT_AN_ADMIN_ACCOUNT).</Alert> : null}
            {alreadyHas ? <Alert tone="info">This account already has that role.</Alert> : null}
            {role ? (
              <div className="flex flex-wrap gap-1" aria-label={`Permissions of ${role.name}`}>
                {role.permissions.map((p) => (
                  <Badge key={p}>{p}</Badge>
                ))}
              </div>
            ) : null}
          </div>
        </ConfirmDialog>
      ) : null}

      {revoke ? (
        <ConfirmDialog
          open
          onClose={() => setRevoke(null)}
          title="Revoke this role?"
          description={`${assignmentLabel(revoke)} for ${user.phone_masked}`}
          effects={['The permissions it gave stop applying immediately.', 'Their sessions stay signed in but lose those permissions on the next request.', 'The change is recorded in the audit log with your account.']}
          confirmLabel="Revoke role"
          tone="danger"
          onConfirm={async () => {
            const body: Record<string, unknown> = { role_code: revoke.code, scope_type: revoke.scope_type };
            if (revoke.scope_id) body.scope_id = revoke.scope_id;
            const res = await bff.post(`/admin/users/${user.id}/roles/revoke`, body);
            if (res.ok || isStaleProblem(res.problem.code) || res.problem.status === 404) router.refresh();
            return toAction(res, 'Role revoked.');
          }}
        />
      ) : null}
    </>
  );
}
