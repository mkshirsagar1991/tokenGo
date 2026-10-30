import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock, ConflictError, FIELD_CIPHER, FieldCipher, ForbiddenError, NotFoundError, UnitOfWork, ValidationFailedError } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { maskPhone, normalizePhone } from '../domain/phone';
import { AuthorizationService } from './authorization.service';
import { PhoneHasher } from './phone-hasher';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'DELETED'] as const;

interface UserRow {
  id: string;
  status: string;
  phone_enc: Buffer;
  created_at: Date;
  last_login_at: Date | null;
  deletion_due_at: Date | null;
  is_admin: boolean;
}
interface RoleRow {
  user_id: string;
  code: string;
  scope_type: string;
  scope_id: string | null;
}

/**
 * Administrator view of accounts and their roles (requirements §4/§21). Phone numbers are only ever shown MASKED; finding a
 * person needs their id or their FULL phone number (there is no partial search, which would be a PII-enumeration tool).
 * Every change is audited with who did it, to whom, and why.
 */
@Injectable()
export class UserAdminService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly phones: PhoneHasher,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
  ) {}

  async list(q: { query?: string; status?: string; role?: string; cursor?: string; limit: number }) {
    const where = [sql`TRUE`];
    if (q.query) {
      const query = q.query.trim();
      if (UUID.test(query)) where.push(sql`u.id = ${query}::uuid`);
      else {
        const e164 = normalizePhone(query);
        if (!e164) throw new ValidationFailedError('Search by a user id or a full phone number');
        where.push(sql`u.phone_hash = ${this.phones.hash(e164)}`);
      }
    }
    if (q.status) where.push(sql`u.status = ${q.status}`);
    if (q.role) where.push(sql`EXISTS (SELECT 1 FROM identity.role_assignments ra JOIN identity.roles r ON r.id = ra.role_id WHERE ra.user_id = u.id AND ra.revoked_at IS NULL AND r.code = ${q.role})`);
    if (q.cursor) where.push(sql`u.id < ${q.cursor}::uuid`);
    const db = this.uow.db<unknown>();
    const rows = (
      await sql<UserRow>`
        SELECT u.id, u.status, u.phone_enc, u.created_at, u.last_login_at, u.deletion_due_at,
               EXISTS (SELECT 1 FROM identity.admin_credentials c WHERE c.user_id = u.id) AS is_admin
          FROM identity.users u WHERE ${sql.join(where, sql` AND `)} ORDER BY u.id DESC LIMIT ${q.limit + 1}`.execute(db)
    ).rows;
    const page = rows.slice(0, q.limit);
    const roles = await this.rolesOf(page.map((r) => r.id));
    return { data: page.map((r) => this.view(r, roles.get(r.id) ?? [])), meta: { next_cursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null } };
  }

  async get(userId: string) {
    const db = this.uow.db<unknown>();
    const row = (
      await sql<UserRow>`
        SELECT u.id, u.status, u.phone_enc, u.created_at, u.last_login_at, u.deletion_due_at,
               EXISTS (SELECT 1 FROM identity.admin_credentials c WHERE c.user_id = u.id) AS is_admin
          FROM identity.users u WHERE u.id = ${userId}`.execute(db)
    ).rows[0];
    if (!row) throw new NotFoundError('User');
    const sessions = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM identity.auth_sessions WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > ${this.clock.now()}`.execute(db)).rows[0]!.n;
    const roles = await this.rolesOf([userId]);
    return { ...this.view(row, roles.get(userId) ?? []), active_sessions: Number(sessions) };
  }

  async roleCatalog() {
    const rows = (
      await sql<{ code: string; name: string; scope_type: string; requires_mfa: boolean; permissions: string[] }>`
        SELECT r.code, r.name, r.scope_type, r.requires_mfa,
               coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
          FROM identity.roles r LEFT JOIN identity.role_permissions rp ON rp.role_id = r.id
         GROUP BY r.id ORDER BY r.scope_type, r.code`.execute(this.uow.db<unknown>())
    ).rows;
    return rows.map((r) => ({ code: r.code, name: r.name, scope_type: r.scope_type, requires_mfa: r.requires_mfa, permissions: r.permissions }));
  }

  async suspend(actorId: string, userId: string, reason: string) {
    if (actorId === userId) throw new ForbiddenError('You cannot suspend your own account');
    await this.uow.run(async () => {
      const db = this.uow.db<unknown>();
      const row = (await sql<{ status: string }>`SELECT status FROM identity.users WHERE id = ${userId} FOR UPDATE`.execute(db)).rows[0];
      if (!row) throw new NotFoundError('User');
      if (row.status !== 'ACTIVE') throw new ConflictError('USER_NOT_ACTIVE', `Only an active account can be suspended (this one is ${row.status})`);
      const now = this.clock.now();
      await sql`UPDATE identity.users SET status = 'SUSPENDED' WHERE id = ${userId}`.execute(db);
      await sql`UPDATE identity.auth_sessions SET revoked_at = ${now}, revoke_reason = 'SUSPENDED' WHERE user_id = ${userId} AND revoked_at IS NULL`.execute(db);
      await this.audit.record({ actorType: 'USER', actorId, action: 'user.suspended', entityType: 'user', entityId: userId, before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' }, metadata: { reason } });
    });
    return this.get(userId);
  }

  async reinstate(actorId: string, userId: string) {
    await this.uow.run(async () => {
      const db = this.uow.db<unknown>();
      const row = (await sql<{ status: string }>`SELECT status FROM identity.users WHERE id = ${userId} FOR UPDATE`.execute(db)).rows[0];
      if (!row) throw new NotFoundError('User');
      if (row.status !== 'SUSPENDED') throw new ConflictError('USER_NOT_SUSPENDED', `Only a suspended account can be reinstated (this one is ${row.status})`);
      await sql`UPDATE identity.users SET status = 'ACTIVE' WHERE id = ${userId}`.execute(db);
      await this.audit.record({ actorType: 'USER', actorId, action: 'user.reinstated', entityType: 'user', entityId: userId, before: { status: 'SUSPENDED' }, after: { status: 'ACTIVE' } });
    });
    return this.get(userId);
  }

  async assignRole(actorId: string, userId: string, input: { roleCode: string; scopeType: 'PLATFORM' | 'PROVIDER' | 'LOCATION'; scopeId?: string }) {
    await this.checkRoleChange(actorId, userId, input, 'assign');
    await this.uow.run(async () => {
      const changed = await this.authz.grantRole(userId, input.roleCode, { type: input.scopeType, id: input.scopeId }, actorId);
      await this.audit.record({
        actorType: 'USER',
        actorId,
        action: 'user.role_granted',
        entityType: 'user',
        entityId: userId,
        after: { role: input.roleCode, scope_type: input.scopeType, scope_id: input.scopeId ?? null },
        metadata: { changed },
      });
    });
    return this.get(userId);
  }

  async revokeRole(actorId: string, userId: string, input: { roleCode: string; scopeType: 'PLATFORM' | 'PROVIDER' | 'LOCATION'; scopeId?: string }) {
    await this.checkRoleChange(actorId, userId, input, 'revoke');
    await this.uow.run(async () => {
      const changed = await this.authz.revokeRole(userId, input.roleCode, { type: input.scopeType, id: input.scopeId });
      if (!changed) throw new NotFoundError('Role assignment');
      await this.audit.record({
        actorType: 'USER',
        actorId,
        action: 'user.role_revoked',
        entityType: 'user',
        entityId: userId,
        before: { role: input.roleCode, scope_type: input.scopeType, scope_id: input.scopeId ?? null },
      });
    });
    return this.get(userId);
  }

  // ---- rules for changing roles -----------------------------------------------------------------------------------------
  private async checkRoleChange(actorId: string, userId: string, input: { roleCode: string; scopeType: string; scopeId?: string }, kind: 'assign' | 'revoke') {
    const db = this.uow.db<unknown>();
    const target = (await sql<{ status: string; is_admin: boolean }>`SELECT u.status, EXISTS (SELECT 1 FROM identity.admin_credentials c WHERE c.user_id = u.id) AS is_admin FROM identity.users u WHERE u.id = ${userId}`.execute(db)).rows[0];
    if (!target) throw new NotFoundError('User');
    // Nobody changes their own privileges: a compromised or careless administrator could otherwise grant themselves anything.
    if (actorId === userId) throw new ForbiddenError('You cannot change your own roles');
    if (input.scopeType === 'PLATFORM' && input.roleCode !== 'CUSTOMER') {
      // Platform staff roles are privileged and require MFA; only accounts that can do MFA (administrator credentials) may hold them.
      if (kind === 'assign' && !target.is_admin) throw new ConflictError('NOT_AN_ADMIN_ACCOUNT', 'Platform roles can only be given to an administrator account (created with the admin CLI)');
    }
    if (input.scopeType !== 'PLATFORM') {
      if (!input.scopeId || !UUID.test(input.scopeId)) throw new ValidationFailedError('scope_id is required for provider and location roles');
      const table = input.scopeType === 'PROVIDER' ? 'provider.providers' : 'provider.provider_locations';
      const exists = (await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM ${sql.raw(table)} WHERE id = ${input.scopeId}::uuid) AS ok`.execute(db)).rows[0]!.ok;
      if (!exists) throw new NotFoundError(input.scopeType === 'PROVIDER' ? 'Provider' : 'Location');
    }
  }

  private async rolesOf(userIds: string[]): Promise<Map<string, { code: string; scope_type: string; scope_id: string | null }[]>> {
    const out = new Map<string, { code: string; scope_type: string; scope_id: string | null }[]>();
    if (userIds.length === 0) return out;
    const rows = (
      await sql<RoleRow>`
        SELECT ra.user_id, r.code, ra.scope_type, ra.scope_id
          FROM identity.role_assignments ra JOIN identity.roles r ON r.id = ra.role_id
         WHERE ra.user_id IN (${sql.join(userIds)}) AND ra.revoked_at IS NULL AND (ra.valid_to IS NULL OR ra.valid_to > ${this.clock.now()})
         ORDER BY r.code`.execute(this.uow.db<unknown>())
    ).rows;
    for (const r of rows) (out.get(r.user_id) ?? out.set(r.user_id, []).get(r.user_id)!).push({ code: r.code, scope_type: r.scope_type, scope_id: r.scope_id });
    return out;
  }

  private view(r: UserRow, roles: { code: string; scope_type: string; scope_id: string | null }[]) {
    let phone = 'deleted';
    if (r.status !== 'DELETED' && r.phone_enc.length > 0) {
      try {
        phone = maskPhone(this.cipher.decrypt(r.phone_enc));
      } catch {
        phone = 'unreadable';
      }
    }
    return {
      id: r.id,
      phone_masked: phone,
      status: r.status,
      is_admin_account: r.is_admin,
      roles,
      created_at: r.created_at.toISOString(),
      last_login_at: r.last_login_at ? r.last_login_at.toISOString() : null,
      deletion_scheduled_for: r.deletion_due_at ? r.deletion_due_at.toISOString() : null,
    };
  }
}
