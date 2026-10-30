import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig, Clock } from '../../../shared-kernel';
import { BankVerification, PayoutDestination, PayoutProvider, PayoutRejectedError, ProviderPayout } from '../domain/payout-provider';
import type { SandboxPayoutsTable, SettlementDb } from './db-types';

const newId = (prefix: string) => `${prefix}_sbx_${randomUUID().replace(/-/g, '')}`;

/**
 * A payout provider that exists ONLY in this database; no money moves. Like the payments sandbox it uses its OWN small pool (a real
 * provider is a separate system whose state does not roll back with ours) and is refused in production by `loadConfig`.
 *
 * Deterministic conventions, so tests and demos can provoke every outcome without a back door in the application:
 *   bank check:  account ending 0000 -> FAILED (account not found) · 1111 -> VERIFIED but registered to "SOMEONE ELSE"
 *                · 2222 -> PENDING on the first look, VERIFIED on the next · anything else -> VERIFIED under the typed name
 *   payout:      beneficiary account ending 9999 -> definitively refused; otherwise accepted as QUEUED and moved on by `advance()`
 */
@Injectable()
export class SandboxPayoutProvider extends PayoutProvider implements OnModuleDestroy {
  readonly name = 'sandbox';
  private kysely?: Kysely<SettlementDb>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    super();
  }

  private get db(): Kysely<SettlementDb> {
    this.kysely ??= new Kysely<SettlementDb>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: this.config.databaseUrl, max: 4 }) }) });
    return this.kysely;
  }

  async onModuleDestroy(): Promise<void> {
    await this.kysely?.destroy();
  }

  // ===== the PayoutProvider contract ==================================================================================
  async verifyBankAccount(input: { reference: string; destination: PayoutDestination }): Promise<BankVerification> {
    const existing = await this.db.selectFrom('settlement.sandbox_bank_checks').selectAll().where('reference', '=', input.reference).executeTakeFirst();
    if (existing) {
      if (existing.status === 'PENDING') {
        await this.db.updateTable('settlement.sandbox_bank_checks').set({ status: 'VERIFIED', name_at_bank: input.destination.holderName }).where('reference', '=', input.reference).execute();
        return { status: 'VERIFIED', nameAtBank: input.destination.holderName };
      }
      return this.toVerification(existing.status, existing.name_at_bank, existing.failure_reason);
    }
    const last4 = input.destination.accountNumber.slice(-4);
    const outcome: { status: 'VERIFIED' | 'FAILED' | 'PENDING'; name: string | null; reason: string | null } =
      last4 === '0000' ? { status: 'FAILED', name: null, reason: 'ACCOUNT_NOT_FOUND' } : last4 === '1111' ? { status: 'VERIFIED', name: 'SOMEONE ELSE', reason: null } : last4 === '2222' ? { status: 'PENDING', name: null, reason: null } : { status: 'VERIFIED', name: input.destination.holderName, reason: null };
    await this.db
      .insertInto('settlement.sandbox_bank_checks')
      .values({ reference: input.reference, account_hash: createHash('sha256').update(`${input.destination.ifsc}:${input.destination.accountNumber}`).digest('hex'), name_at_bank: outcome.name, status: outcome.status, failure_reason: outcome.reason, created_at: this.clock.now() })
      .onConflict((oc) => oc.column('reference').doNothing())
      .execute();
    return this.toVerification(outcome.status, outcome.name, outcome.reason);
  }

  async createPayout(input: { reference: string; amountMinor: bigint; currency: string; destination: PayoutDestination }): Promise<ProviderPayout> {
    const existing = await this.db.selectFrom('settlement.sandbox_payouts').selectAll().where('reference', '=', input.reference).executeTakeFirst();
    if (existing) {
      if (BigInt(existing.amount_minor) !== input.amountMinor) throw new PayoutRejectedError('REFERENCE_REUSED', 'This reference was already used for a different amount');
      return this.toPayout(existing); // the SAME payout — never a second transfer
    }
    if (input.amountMinor <= 0n) throw new PayoutRejectedError('INVALID_AMOUNT', 'The payout amount must be positive');
    const last4 = input.destination.accountNumber.slice(-4);
    if (last4 === '9999') throw new PayoutRejectedError('BENEFICIARY_BLOCKED', 'The beneficiary account cannot receive payouts');
    const now = this.clock.now();
    await this.db
      .insertInto('settlement.sandbox_payouts')
      .values({ provider_payout_id: newId('pout'), reference: input.reference, amount_minor: input.amountMinor.toString(), currency: input.currency, destination_last4: last4, status: 'QUEUED', utr: null, failure_reason: null, created_at: now, updated_at: now })
      .onConflict((oc) => oc.column('reference').doNothing())
      .execute();
    return this.toPayout(await this.db.selectFrom('settlement.sandbox_payouts').selectAll().where('reference', '=', input.reference).executeTakeFirstOrThrow());
  }

  async fetchPayoutByReference(reference: string): Promise<ProviderPayout | null> {
    const row = await this.db.selectFrom('settlement.sandbox_payouts').selectAll().where('reference', '=', reference).executeTakeFirst();
    return row ? this.toPayout(row) : null;
  }

  async listPayouts(range: { from: Date; to: Date }): Promise<ProviderPayout[]> {
    const rows = await this.db
      .selectFrom('settlement.sandbox_payouts')
      .selectAll()
      .where('created_at', '>=', range.from)
      .where('created_at', '<', range.to)
      .orderBy('created_at')
      .orderBy('provider_payout_id')
      .execute();
    return rows.map((r) => this.toPayout(r));
  }

  // ===== simulator control (what the bank would do) ===================================================================
  async advance(reference: string, outcome: 'PROCESSING' | 'PAID' | 'FAILED' | 'REVERSED', opts: { utr?: string; reason?: string } = {}): Promise<ProviderPayout> {
    await this.db
      .updateTable('settlement.sandbox_payouts')
      .set({ status: outcome, utr: outcome === 'PAID' ? (opts.utr ?? `UTR${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`) : undefined, failure_reason: outcome === 'FAILED' || outcome === 'REVERSED' ? (opts.reason ?? outcome) : undefined, updated_at: this.clock.now() })
      .where('reference', '=', reference)
      .execute();
    return (await this.fetchPayoutByReference(reference))!;
  }

  // ===== mapping ======================================================================================================
  private toVerification(status: 'VERIFIED' | 'FAILED' | 'PENDING', name: string | null, reason: string | null): BankVerification {
    return { status, ...(name ? { nameAtBank: name } : {}), ...(reason ? { failureReason: reason } : {}) };
  }

  private toPayout(row: SandboxPayoutsTable): ProviderPayout {
    return { provider: this.name, payoutId: row.provider_payout_id, reference: row.reference, amountMinor: BigInt(row.amount_minor), currency: row.currency, status: row.status, ...(row.utr ? { utr: row.utr } : {}), ...(row.failure_reason ? { failureReason: row.failure_reason } : {}), createdAt: row.created_at };
  }
}
