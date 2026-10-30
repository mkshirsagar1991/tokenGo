import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { APP_CONFIG, AppConfig, Clock, ConflictError, DeletionGuardRegistry, NotFoundError, OutboxService, UnitOfWork } from '../../../shared-kernel';
import { AuditService } from '../../audit';

const DAY_MS = 86_400_000;

interface UserState {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'DELETED';
  phone_hash: string;
  deletion_due_at: Date | null;
}

/**
 * Account deletion: request -> grace period -> anonymisation.
 *  - REQUEST deactivates the account, signs the person out everywhere and schedules the end of the grace period. It is refused
 *    (with reasons a person can act on) while any module still has an obligation: an open booking, money in the wallet, an
 *    active business with earnings, ...
 *  - SIGNING IN again before the due time cancels the request ("restoreOnLogin").
 *  - At the due time the worker ANONYMISES the account: the phone number and every credential are removed, the row is kept as a
 *    tombstone because bookings and the ledger must keep pointing at *something* (financial records are not deleted).
 * Other modules clean up their own data by consuming `identity.user_deleted`.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly guards: DeletionGuardRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async request(userId: string): Promise<{ due_at: string }> {
    return this.uow.run(async () => {
      const user = await this.lockUser(userId);
      if (!user) throw new NotFoundError('User');
      if (user.status !== 'ACTIVE') throw new ConflictError('ACCOUNT_NOT_ACTIVE', 'This account is not active');
      const reasons = await this.guards.blockers(userId);
      if (reasons.length) throw new ConflictError('ACCOUNT_DELETION_BLOCKED', 'Your account cannot be deleted yet', { reasons });

      const now = this.clock.now();
      const due = new Date(now.getTime() + this.config.accountDeletionGraceDays * DAY_MS);
      const db = this.uow.db<unknown>();
      await sql`UPDATE identity.users SET status = 'DEACTIVATED', deletion_requested_at = ${now}, deletion_due_at = ${due}, deletion_blocked_reason = NULL WHERE id = ${userId}`.execute(db);
      await sql`UPDATE identity.auth_sessions SET revoked_at = ${now}, revoke_reason = 'ACCOUNT_DELETION' WHERE user_id = ${userId} AND revoked_at IS NULL`.execute(db);
      await this.audit.record({ actorType: 'USER', actorId: userId, action: 'account.deletion_requested', entityType: 'user', entityId: userId, metadata: { due_at: due.toISOString() } });
      await this.outbox.publish({ type: 'identity.user_deletion_requested', aggregateType: 'user', aggregateId: userId, payload: { user_id: userId, due_at: due.toISOString() } });
      await this.outbox.publish({ type: 'identity.user_deletion_due', aggregateType: 'user', aggregateId: userId, payload: { user_id: userId }, availableAt: due });
      return { due_at: due.toISOString() };
    });
  }

  /** Inside the sign-in transaction: a person who comes back during the grace period gets their account back. */
  async restoreOnLogin(userId: string): Promise<boolean> {
    const user = await this.lockUser(userId);
    if (!user || user.status !== 'DEACTIVATED' || !user.deletion_due_at || user.deletion_due_at <= this.clock.now()) return false;
    await sql`UPDATE identity.users SET status = 'ACTIVE', deletion_requested_at = NULL, deletion_due_at = NULL, deletion_blocked_reason = NULL WHERE id = ${userId}`.execute(this.uow.db<unknown>());
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'account.deletion_cancelled', entityType: 'user', entityId: userId });
    await this.outbox.publish({ type: 'identity.user_deletion_cancelled', aggregateType: 'user', aggregateId: userId, payload: { user_id: userId } });
    return true;
  }

  /** Worker: carry the deletion out if it is still wanted and nothing blocks it now. Safe to run any number of times. */
  async finalizeIfDue(userId: string): Promise<'DELETED' | 'SKIPPED' | 'BLOCKED'> {
    return this.uow.run(async () => {
      const user = await this.lockUser(userId);
      const now = this.clock.now();
      if (!user || user.status !== 'DEACTIVATED' || !user.deletion_due_at || user.deletion_due_at > now) return 'SKIPPED'; // cancelled, already done, or early

      // The world may have changed since the request (a late refund credited the wallet, a booking was made before the request
      // committed, ...). A guard that objects now postpones the deletion a day and records why, rather than losing money or records.
      const reasons = await this.guards.blockers(userId);
      const db = this.uow.db<unknown>();
      if (reasons.length) {
        const next = new Date(now.getTime() + DAY_MS);
        await sql`UPDATE identity.users SET deletion_blocked_reason = ${reasons.join('; ').slice(0, 500)} WHERE id = ${userId}`.execute(db);
        await this.audit.record({ actorType: 'SYSTEM', action: 'account.deletion_blocked', entityType: 'user', entityId: userId, metadata: { reasons } });
        await this.outbox.publish({ type: 'identity.user_deletion_due', aggregateType: 'user', aggregateId: userId, payload: { user_id: userId }, availableAt: next });
        return 'BLOCKED';
      }

      // Tombstone: nothing that identifies the person survives. The id stays because bookings and ledger rows reference it.
      await sql`DELETE FROM identity.otp_challenges WHERE phone_hash = ${user.phone_hash}`.execute(db);
      await sql`UPDATE identity.auth_sessions SET revoked_at = COALESCE(revoked_at, ${now}), revoke_reason = COALESCE(revoke_reason, 'ACCOUNT_DELETED') WHERE user_id = ${userId}`.execute(db);
      await sql`UPDATE identity.role_assignments SET revoked_at = ${now} WHERE user_id = ${userId} AND revoked_at IS NULL`.execute(db);
      await sql`
        UPDATE identity.users
           SET status = 'DELETED', phone_hash = ${'deleted:' + userId}, phone_enc = '\\x'::bytea, email_enc = NULL,
               deletion_due_at = NULL, deletion_requested_at = NULL, deletion_blocked_reason = NULL
         WHERE id = ${userId}`.execute(db);
      await this.audit.record({ actorType: 'SYSTEM', action: 'account.deleted', entityType: 'user', entityId: userId });
      await this.outbox.publish({ type: 'identity.user_deleted', aggregateType: 'user', aggregateId: userId, payload: { user_id: userId } });
      return 'DELETED';
    });
  }

  private async lockUser(userId: string): Promise<UserState | undefined> {
    return (
      await sql<UserState>`SELECT id, status, phone_hash, deletion_due_at FROM identity.users WHERE id = ${userId} FOR UPDATE`.execute(this.uow.db<unknown>())
    ).rows[0];
  }
}
