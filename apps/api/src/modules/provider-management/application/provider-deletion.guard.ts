import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DeletionGuard, DeletionGuardRegistry, UnitOfWork } from '../../../shared-kernel';

/**
 * Closing a business involves obligations (bookings, earnings still owed, a bank account, tax records) that only the platform can
 * settle, so an owner of a business that is past the draft stage cannot delete the account themselves.
 */
@Injectable()
export class ProviderDeletionGuard implements DeletionGuard {
  readonly name = 'provider';

  constructor(
    private readonly uow: UnitOfWork,
    registry: DeletionGuardRegistry,
  ) {
    registry.register(this);
  }

  async blockers(userId: string): Promise<string[]> {
    const { n } = (
      await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM provider.providers
         WHERE owner_user_id = ${userId} AND deleted_at IS NULL AND status NOT IN ('DRAFT', 'REJECTED')`.execute(this.uow.db<unknown>())
    ).rows[0]!;
    return Number(n) === 0 ? [] : ['You own a business on TokenGo. Contact support to close the business before deleting your account.'];
  }
}
