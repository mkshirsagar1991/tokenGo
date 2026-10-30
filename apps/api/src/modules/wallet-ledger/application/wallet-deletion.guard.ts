import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DeletionGuard, DeletionGuardRegistry, UnitOfWork } from '../../../shared-kernel';

/** ₹1,250 / ₹99.50 — integer arithmetic only. */
const rupees = (minor: bigint) => `₹${(minor / 100n).toLocaleString('en-IN')}${minor % 100n === 0n ? '' : '.' + String(minor % 100n).padStart(2, '0')}`;

/**
 * Money is never deleted. An account with a balance (or money held for a booking) cannot be deleted: the person must spend it
 * or ask support to refund it to their original payment method first, so no one loses funds by closing an account.
 */
@Injectable()
export class WalletDeletionGuard implements DeletionGuard {
  readonly name = 'wallet';

  constructor(
    private readonly uow: UnitOfWork,
    registry: DeletionGuardRegistry,
  ) {
    registry.register(this);
  }

  async blockers(userId: string): Promise<string[]> {
    const row = (
      await sql<{ available: string | null; held: string | null; currency: string }>`
        SELECT a.balance_minor::text AS available, h.balance_minor::text AS held, w.currency
          FROM ledger.wallet_accounts w
          JOIN ledger.accounts a ON a.id = w.available_account_id
          JOIN ledger.accounts h ON h.id = w.held_account_id
         WHERE w.customer_id = ${userId}`.execute(this.uow.db<unknown>())
    ).rows[0];
    if (!row) return [];
    const reasons: string[] = [];
    if (BigInt(row.available ?? 0) > 0n) reasons.push(`Your wallet still holds ${rupees(BigInt(row.available ?? 0))}. Spend it, or contact support to have it refunded, before deleting your account.`);
    if (BigInt(row.held ?? 0) > 0n) reasons.push(`${rupees(BigInt(row.held ?? 0))} is reserved for a booking. Wait for it to finish first.`);
    return reasons;
  }
}
