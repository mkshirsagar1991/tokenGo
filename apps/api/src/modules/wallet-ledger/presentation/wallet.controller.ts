import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Actor, CurrentActor, Money, RequirePlatformPermission } from '../../../shared-kernel';
import { LedgerIntegrityService } from '../application/ledger-integrity.service';
import { LedgerService } from '../application/ledger.service';

class StatementQuery {
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() cursor?: string;
}

/** What each ledger transaction type is called to a customer. */
const LABELS: Record<string, string> = {
  TOPUP: 'Added to wallet',
  DEV_TEST_CREDIT: 'Test funds (development only)',
  HOLD_CREATE: 'Reserved for a booking',
  HOLD_RELEASE: 'Released back to your wallet',
  HOLD_SETTLE: 'Paid for a booking',
  REVERSAL: 'Correction',
  // Neutral on purpose: this entry is the customer's ONLY refund line and it stays on the statement after the refund completes
  // (the completing posting touches platform accounts only), so it must read correctly both while pending and when done.
  REFUND_RESERVE: 'Refund to your original payment method',
};

@ApiTags('wallet')
@Controller({ path: 'wallet', version: '1' })
export class WalletController {
  constructor(private readonly ledger: LedgerService) {}

  /** The customer's own balances — transparent available vs. held (requirements §33). */
  @Get()
  async balance(@CurrentActor() actor: Actor) {
    const { available, held } = await this.ledger.getBalance(actor.userId);
    return { data: { available: available.toJSON(), held: held.toJSON() } };
  }

  @Get('transactions')
  async statement(@CurrentActor() actor: Actor, @Query() q: StatementQuery) {
    const limit = q.limit ?? 30;
    const rows = await this.ledger.listWalletEntries(actor.userId, { limit: limit + 1, beforeEntryId: q.cursor });
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) => ({
        id: r.entry_id,
        type: r.txn_type,
        label: LABELS[r.txn_type] ?? r.txn_type,
        account: r.account,
        direction: r.direction,
        amount: Money.of(BigInt(r.amount_minor), r.currency).toJSON(),
        balance_after: Money.of(BigInt(r.balance_after_minor), r.currency).toJSON(),
        booking_id: r.booking_id,
        posted_at: r.posted_at,
      })),
      meta: { next_cursor: rows.length > limit ? (page[page.length - 1]?.entry_id ?? null) : null },
    };
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/ledger', version: '1' })
export class LedgerAdminController {
  constructor(private readonly integrity: LedgerIntegrityService) {}

  /** Finance/admin: reconcile the ledger against itself. Read-only; reports, never repairs. */
  @Get('integrity')
  @RequirePlatformPermission('ledger:read')
  async check() {
    return { data: await this.integrity.check() };
  }
}
