import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, Clock, UnitOfWork, uuidv7 } from '../../../shared-kernel';
import type { SettlementDb } from '../infrastructure/db-types';

export interface PayableCredit {
  providerId: string;
  bookingId: string | null;
  ledgerTxnId: string;
  netMinor: bigint;
  commissionMinor: bigint;
  currency: string;
}

/**
 * A PAYABLE is money the platform owes a provider. It is NOT money already paid into the provider's bank account (requirements §19):
 * it becomes payable-by-bank only after a delay, once a verified bank account exists, and is paid by a separate payout.
 *
 * Rows are recorded from the ledger's own "provider payable credited" event, so every way a provider can earn — a completed
 * service, a late-cancellation fee, a no-show fee — is covered by one mechanism, and the ledger stays the source of truth.
 */
@Injectable()
export class PayableService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** Idempotent: one row per (ledger posting, provider), so a redelivered event records nothing new. */
  async record(c: PayableCredit): Promise<'RECORDED' | 'DUPLICATE' | 'IGNORED'> {
    if (c.netMinor <= 0n || c.commissionMinor < 0n) return 'IGNORED';
    const now = this.clock.now();
    const res = await this.uow
      .db<SettlementDb>()
      .insertInto('settlement.provider_payables')
      .values({
        id: uuidv7(),
        provider_id: c.providerId,
        ledger_txn_id: c.ledgerTxnId,
        booking_id: c.bookingId,
        currency: c.currency,
        net_minor: c.netMinor.toString(),
        commission_minor: c.commissionMinor.toString(),
        eligible_at: new Date(now.getTime() + this.config.payouts.delayHours * 3_600_000),
        payout_id: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['ledger_txn_id', 'provider_id']).doNothing())
      .executeTakeFirst();
    return Number(res.numInsertedOrUpdatedRows ?? 0) > 0 ? 'RECORDED' : 'DUPLICATE';
  }
}
