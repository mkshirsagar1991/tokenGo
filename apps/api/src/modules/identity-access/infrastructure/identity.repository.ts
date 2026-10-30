import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { UnitOfWork, uuidv7 } from '../../../shared-kernel';
import type { IdentityDb } from './db-types';

export type ScopeType = 'PLATFORM' | 'PROVIDER' | 'LOCATION';

export interface UserRow {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'DELETED';
  phone_hash: string;
}

@Injectable()
export class IdentityRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.db<IdentityDb>();
  }

  // --- users --------------------------------------------------------------------------------
  findUserByPhoneHash(phoneHash: string): Promise<UserRow | undefined> {
    return this.db
      .selectFrom('identity.users')
      .select(['id', 'status', 'phone_hash'])
      .where('phone_hash', '=', phoneHash)
      .executeTakeFirst();
  }

  findUserById(id: string): Promise<UserRow | undefined> {
    return this.db
      .selectFrom('identity.users')
      .select(['id', 'status', 'phone_hash'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Race-safe: concurrent first logins for the same phone converge on one row via the unique blind index. */
  async createUserIfAbsent(phoneHash: string, phoneEnc: Buffer): Promise<{ user: UserRow; created: boolean }> {
    const inserted = await this.db
      .insertInto('identity.users')
      .values({ id: uuidv7(), phone_hash: phoneHash, phone_enc: phoneEnc, email_enc: null, status: 'ACTIVE', last_login_at: null })
      .onConflict((oc) => oc.column('phone_hash').doNothing())
      .returning(['id', 'status', 'phone_hash'])
      .executeTakeFirst();
    if (inserted) return { user: inserted, created: true };
    const existing = await this.findUserByPhoneHash(phoneHash);
    if (!existing) throw new Error('user vanished between insert and select');
    return { user: existing, created: false };
  }

  touchLastLogin(userId: string): Promise<unknown> {
    return this.db
      .updateTable('identity.users')
      .set({ last_login_at: sql<Date>`now()` })
      .where('id', '=', userId)
      .execute();
  }

  // --- OTP ----------------------------------------------------------------------------------
  async lastChallengeCreatedAt(phoneHash: string): Promise<Date | undefined> {
    const row = await this.db
      .selectFrom('identity.otp_challenges')
      .select('created_at')
      .where('phone_hash', '=', phoneHash)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.created_at;
  }

  invalidateOpenChallenges(phoneHash: string, now: Date): Promise<unknown> {
    return this.db
      .updateTable('identity.otp_challenges')
      .set({ consumed_at: now })
      .where('phone_hash', '=', phoneHash)
      .where('consumed_at', 'is', null)
      .execute();
  }

  insertChallenge(row: {
    id: string;
    phoneHash: string;
    codeHash: string;
    createdAt: Date;
    expiresAt: Date;
    maxAttempts: number;
    ipHash: string | null;
    deviceId: string | null;
  }): Promise<unknown> {
    return this.db
      .insertInto('identity.otp_challenges')
      .values({
        id: row.id,
        phone_hash: row.phoneHash,
        code_hash: row.codeHash,
        created_at: row.createdAt,
        expires_at: row.expiresAt,
        max_attempts: row.maxAttempts,
        consumed_at: null,
        requested_ip_hash: row.ipHash,
        device_id: row.deviceId,
      })
      .execute();
  }

  /** Locks the latest open challenge so concurrent verifications of one OTP serialise. */
  lockLatestOpenChallenge(phoneHash: string, now: Date) {
    return this.db
      .selectFrom('identity.otp_challenges')
      .select(['id', 'code_hash', 'attempts', 'max_attempts'])
      .where('phone_hash', '=', phoneHash)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('created_at', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
  }

  recordFailedAttempt(challengeId: string): Promise<unknown> {
    return this.db
      .updateTable('identity.otp_challenges')
      .set({ attempts: sql<number>`attempts + 1` })
      .where('id', '=', challengeId)
      .execute();
  }

  consumeChallenge(challengeId: string, now: Date): Promise<unknown> {
    return this.db.updateTable('identity.otp_challenges').set({ consumed_at: now }).where('id', '=', challengeId).execute();
  }

  // --- sessions & refresh tokens ----------------------------------------------------------------
  createSession(row: {
    id: string;
    userId: string;
    deviceId: string | null;
    userAgent: string | null;
    expiresAt: Date;
    mfaVerifiedAt: Date | null;
  }) {
    return this.db
      .insertInto('identity.auth_sessions')
      .values({
        id: row.id,
        user_id: row.userId,
        device_id: row.deviceId,
        user_agent: row.userAgent,
        expires_at: row.expiresAt,
        revoked_at: null,
        revoke_reason: null,
        mfa_verified_at: row.mfaVerifiedAt,
      })
      .execute();
  }

  insertRefreshToken(row: { id: string; sessionId: string; tokenHash: string; expiresAt: Date }) {
    return this.db
      .insertInto('identity.refresh_tokens')
      .values({ id: row.id, session_id: row.sessionId, token_hash: row.tokenHash, expires_at: row.expiresAt, rotated_at: null })
      .execute();
  }

  /** Locks the token row: simultaneous refreshes with the same token serialise here. */
  lockRefreshToken(tokenHash: string) {
    return this.db
      .selectFrom('identity.refresh_tokens as t')
      .innerJoin('identity.auth_sessions as s', 's.id', 't.session_id')
      .select([
        't.id as token_id',
        't.rotated_at',
        't.expires_at as token_expires_at',
        's.id as session_id',
        's.user_id',
        's.revoked_at',
        's.expires_at as session_expires_at',
        's.device_id',
      ])
      .where('t.token_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();
  }

  markTokenRotated(tokenId: string, now: Date) {
    return this.db.updateTable('identity.refresh_tokens').set({ rotated_at: now }).where('id', '=', tokenId).execute();
  }

  touchSession(sessionId: string, now: Date) {
    return this.db.updateTable('identity.auth_sessions').set({ last_used_at: now }).where('id', '=', sessionId).execute();
  }

  async revokeSession(sessionId: string, reason: string, now: Date, userId?: string): Promise<boolean> {
    let q = this.db
      .updateTable('identity.auth_sessions')
      .set({ revoked_at: now, revoke_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null);
    if (userId) q = q.where('user_id', '=', userId);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  listActiveSessions(userId: string, now: Date) {
    return this.db
      .selectFrom('identity.auth_sessions')
      .select(['id', 'device_id', 'user_agent', 'created_at', 'last_used_at'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('last_used_at', 'desc')
      .execute();
  }

  /** Used by the auth guard on every request: session still active AND user still ACTIVE. */
  getSessionPrincipal(sessionId: string, now: Date) {
    return this.db
      .selectFrom('identity.auth_sessions as s')
      .innerJoin('identity.users as u', 'u.id', 's.user_id')
      .select(['s.user_id', 's.revoked_at', 's.expires_at', 's.mfa_verified_at', 'u.status'])
      .where('s.id', '=', sessionId)
      .where('s.expires_at', '>', now)
      .executeTakeFirst();
  }

  // --- rate limiting ----------------------------------------------------------------------------
  /** Atomic fixed-window counter increment; returns the count INCLUDING this hit. */
  async hitRateLimit(key: string, windowStart: Date): Promise<number> {
    const row = await this.db
      .insertInto('platform.rate_limit_counters')
      .values({ key, window_start: windowStart, count: 1 })
      .onConflict((oc) => oc.columns(['key', 'window_start']).doUpdateSet({ count: sql<number>`platform.rate_limit_counters.count + 1` }))
      .returning('count')
      .executeTakeFirstOrThrow();
    return row.count;
  }

  // --- roles / authorization --------------------------------------------------------------------
  async findRoleByCode(code: string) {
    return this.db.selectFrom('identity.roles').select(['id', 'code', 'scope_type']).where('code', '=', code).executeTakeFirst();
  }

  /** Idempotent grant: re-granting an active assignment is a no-op. */
  async grantRole(row: { userId: string; roleId: string; scopeType: ScopeType; scopeId: string | null; grantedBy: string | null }) {
    const res = await this.db
      .insertInto('identity.role_assignments')
      .values({
        id: uuidv7(),
        user_id: row.userId,
        role_id: row.roleId,
        scope_type: row.scopeType,
        scope_id: row.scopeId,
        granted_by: row.grantedBy,
        valid_to: null,
        revoked_at: null,
      })
      // No explicit target: the partial unique index `role_assignments_active_key` is the only
      // uniqueness rule that can fire here, and a target-less DO NOTHING covers it.
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    return Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async revokeRole(userId: string, roleId: string, scopeType: ScopeType, scopeId: string | null, now: Date) {
    let q = this.db
      .updateTable('identity.role_assignments')
      .set({ revoked_at: now })
      .where('user_id', '=', userId)
      .where('role_id', '=', roleId)
      .where('scope_type', '=', scopeType)
      .where('revoked_at', 'is', null);
    q = scopeId ? q.where('scope_id', '=', scopeId) : q.where('scope_id', 'is', null);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  /**
   * `mfaVerified` = the CURRENT session completed MFA. Roles flagged `requires_mfa` contribute no
   * permissions to a session that has not (a stolen/SIM-swapped OTP login never carries admin power).
   */
  async hasPermission(
    userId: string,
    permission: string,
    scope: { providerId?: string; locationId?: string; locationIds?: string[] },
    now: Date,
    mfaVerified: boolean,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom('identity.role_assignments as ra')
      .innerJoin('identity.roles as r', 'r.id', 'ra.role_id')
      .innerJoin('identity.role_permissions as rp', 'rp.role_id', 'ra.role_id')
      .select(sql<number>`1`.as('ok'))
      .where('ra.user_id', '=', userId)
      .where('rp.permission_code', '=', permission)
      .where('ra.revoked_at', 'is', null)
      .where((eb) => (mfaVerified ? eb.val(true) : eb('r.requires_mfa', '=', false)))
      .where((eb) => eb.or([eb('ra.valid_to', 'is', null), eb('ra.valid_to', '>', now)]))
      .where((eb) => {
        const clauses = [eb('ra.scope_type', '=', 'PLATFORM')];
        if (scope.providerId) clauses.push(eb.and([eb('ra.scope_type', '=', 'PROVIDER'), eb('ra.scope_id', '=', scope.providerId)]));
        if (scope.locationId) clauses.push(eb.and([eb('ra.scope_type', '=', 'LOCATION'), eb('ra.scope_id', '=', scope.locationId)]));
        if (scope.locationIds && scope.locationIds.length > 0) {
          clauses.push(eb.and([eb('ra.scope_type', '=', 'LOCATION'), eb('ra.scope_id', 'in', scope.locationIds)]));
        }
        return eb.or(clauses);
      })
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Does the user hold ANY active role bound to this provider — directly, or via one of its locations?
   * The caller (provider-management) supplies the location ids: the identity module must not read
   * another module's tables (docs §D.2 rule 2).
   */
  async hasAnyAccessToProvider(userId: string, providerId: string, locationIds: string[], now: Date): Promise<boolean> {
    const row = await this.db
      .selectFrom('identity.role_assignments as ra')
      .select(sql<number>`1`.as('ok'))
      .where('ra.user_id', '=', userId)
      .where('ra.revoked_at', 'is', null)
      .where((eb) => eb.or([eb('ra.valid_to', 'is', null), eb('ra.valid_to', '>', now)]))
      .where((eb) => {
        const clauses = [eb.and([eb('ra.scope_type', '=', 'PROVIDER'), eb('ra.scope_id', '=', providerId)])];
        if (locationIds.length > 0) {
          clauses.push(eb.and([eb('ra.scope_type', '=', 'LOCATION'), eb('ra.scope_id', 'in', locationIds)]));
        }
        return eb.or(clauses);
      })
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async getPhoneEnc(userId: string): Promise<Buffer | undefined> {
    const row = await this.db.selectFrom('identity.users').select('phone_enc').where('id', '=', userId).executeTakeFirst();
    return row?.phone_enc;
  }

  async getPhoneHash(userId: string): Promise<string | undefined> {
    const row = await this.db.selectFrom('identity.users').select('phone_hash').where('id', '=', userId).executeTakeFirst();
    return row?.phone_hash;
  }

  async listPermissionsForUser(userId: string, now: Date, mfaVerified: boolean): Promise<string[]> {
    const rows = await this.db
      .selectFrom('identity.role_assignments as ra')
      .innerJoin('identity.roles as r', 'r.id', 'ra.role_id')
      .innerJoin('identity.role_permissions as rp', 'rp.role_id', 'ra.role_id')
      .select('rp.permission_code')
      .distinct()
      .where('ra.user_id', '=', userId)
      .where('ra.revoked_at', 'is', null)
      .where((eb) => (mfaVerified ? eb.val(true) : eb('r.requires_mfa', '=', false)))
      .where((eb) => eb.or([eb('ra.valid_to', 'is', null), eb('ra.valid_to', '>', now)]))
      .execute();
    return rows.map((r) => r.permission_code).sort();
  }

  /** Does the user hold an active role that needs MFA? Used to turn a bare 403 into `MFA_REQUIRED`. */
  async holdsMfaRole(userId: string, now: Date): Promise<boolean> {
    const row = await this.db
      .selectFrom('identity.role_assignments as ra')
      .innerJoin('identity.roles as r', 'r.id', 'ra.role_id')
      .select(sql<number>`1`.as('ok'))
      .where('ra.user_id', '=', userId)
      .where('ra.revoked_at', 'is', null)
      .where('r.requires_mfa', '=', true)
      .where((eb) => eb.or([eb('ra.valid_to', 'is', null), eb('ra.valid_to', '>', now)]))
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  // --- privileged (admin) credentials ---------------------------------------------------------------
  findAdminCredentialsByEmailHash(emailHash: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db
      .selectFrom('identity.admin_credentials')
      .select(['user_id', 'password_hash', 'failed_attempts', 'locked_until', 'mfa_enabled_at', 'mfa_secret_enc', 'mfa_last_step'])
      .where('email_hash', '=', emailHash);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  findAdminCredentialsByUserId(userId: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db
      .selectFrom('identity.admin_credentials')
      .select(['user_id', 'email_enc', 'password_hash', 'failed_attempts', 'locked_until', 'mfa_enabled_at', 'mfa_secret_enc', 'mfa_last_step'])
      .where('user_id', '=', userId);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  insertAdminCredentials(row: { userId: string; emailHash: string; emailEnc: Buffer; passwordHash: string }) {
    return this.db
      .insertInto('identity.admin_credentials')
      .values({
        user_id: row.userId,
        email_hash: row.emailHash,
        email_enc: row.emailEnc,
        password_hash: row.passwordHash,
        locked_until: null,
        mfa_secret_enc: null,
        mfa_enabled_at: null,
        mfa_last_step: null,
      })
      .execute();
  }

  /** Increments the failure counter; at `lockThreshold` failures the account locks and the counter resets. */
  async registerFailedLogin(userId: string, now: Date, lockThreshold: number, lockMs: number): Promise<{ locked: boolean }> {
    const row = await this.db
      .updateTable('identity.admin_credentials')
      .set({ failed_attempts: sql<number>`failed_attempts + 1` })
      .where('user_id', '=', userId)
      .returning('failed_attempts')
      .executeTakeFirstOrThrow();
    if (row.failed_attempts < lockThreshold) return { locked: false };
    await this.db
      .updateTable('identity.admin_credentials')
      .set({ failed_attempts: 0, locked_until: new Date(now.getTime() + lockMs) })
      .where('user_id', '=', userId)
      .execute();
    return { locked: true };
  }

  resetFailedLogins(userId: string) {
    return this.db
      .updateTable('identity.admin_credentials')
      .set({ failed_attempts: 0, locked_until: null })
      .where('user_id', '=', userId)
      .execute();
  }

  setPendingMfaSecret(userId: string, secretEnc: Buffer) {
    return this.db
      .updateTable('identity.admin_credentials')
      .set({ mfa_secret_enc: secretEnc })
      .where('user_id', '=', userId)
      .where('mfa_enabled_at', 'is', null)
      .execute();
  }

  activateMfa(userId: string, now: Date, step: number) {
    return this.db
      .updateTable('identity.admin_credentials')
      .set({ mfa_enabled_at: now, mfa_last_step: String(step) })
      .where('user_id', '=', userId)
      .execute();
  }

  /** Compare-and-set: accepts a TOTP step only if it is newer than the last accepted one (replay defence). */
  async advanceMfaStep(userId: string, step: number): Promise<boolean> {
    const res = await this.db
      .updateTable('identity.admin_credentials')
      .set({ mfa_last_step: String(step) })
      .where('user_id', '=', userId)
      .where((eb) => eb.or([eb('mfa_last_step', 'is', null), eb('mfa_last_step', '<', String(step))]))
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  replaceRecoveryCodes(userId: string, hashes: string[]) {
    return this.db
      .deleteFrom('identity.mfa_recovery_codes')
      .where('user_id', '=', userId)
      .execute()
      .then(() =>
        this.db
          .insertInto('identity.mfa_recovery_codes')
          .values(hashes.map((h) => ({ id: uuidv7(), user_id: userId, code_hash: h, used_at: null })))
          .execute(),
      );
  }

  async consumeRecoveryCode(userId: string, codeHash: string, now: Date): Promise<boolean> {
    const res = await this.db
      .updateTable('identity.mfa_recovery_codes')
      .set({ used_at: now })
      .where('user_id', '=', userId)
      .where('code_hash', '=', codeHash)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const row = await this.db
      .selectFrom('identity.mfa_recovery_codes')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow();
    return row.n;
  }
}
