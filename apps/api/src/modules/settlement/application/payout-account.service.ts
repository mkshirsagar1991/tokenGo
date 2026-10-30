import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../audit';
import { ProviderAccessService } from '../../provider-management';
import {
  APP_CONFIG,
  AppConfig,
  Clock,
  ConflictError,
  FIELD_CIPHER,
  FieldCipher,
  NotFoundError,
  OutboxService,
  TooManyRequestsError,
  UnitOfWork,
  ValidationFailedError,
  hmacSha256Hex,
  pgConstraint,
  uuidv7,
} from '../../../shared-kernel';
import { PayoutProvider } from '../domain/payout-provider';
import {
  isValidAccountNumber,
  isValidHolderName,
  isValidIfsc,
  maskAccountNumber,
  namesMatch,
  normalizeAccountNumber,
  normalizeHolderName,
  normalizeIfsc,
} from '../domain/payout-rules';
import type { AccountStatus, PayoutAccountRow, SettlementDb } from '../infrastructure/db-types';

export interface PayoutAccountView {
  id: string;
  provider_id: string;
  holder_name: string;
  ifsc: string;
  /** Only ever masked: the account number cannot be read back through any endpoint. */
  account_number: string;
  status: AccountStatus;
  failure_reason: string | null;
  verified_at: string | null;
  created_at: string;
}

/** Changing bank details is the classic account-takeover move, so it is rate-limited and every change is verified before it can be paid. */
const MAX_CHANGES_PER_DAY = 5;

/**
 * The provider's payout destination. The account number and holder name are encrypted at rest; clients see them masked. A new
 * account REPLACES the old one atomically and starts unverified: nothing is paid to it until the bank check passes (and the
 * cooling-off period has elapsed — see PayoutService).
 */
@Injectable()
export class PayoutAccountService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly access: ProviderAccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly provider: PayoutProvider,
  ) {}

  private get db() {
    return this.uow.db<SettlementDb>();
  }

  async set(userId: string, providerId: string, input: { holderName: string; accountNumber: string; ifsc: string }): Promise<PayoutAccountView> {
    await this.access.require(userId, 'payout_account:manage', providerId);

    const holderName = normalizeHolderName(input.holderName);
    const accountNumber = normalizeAccountNumber(input.accountNumber);
    const ifsc = normalizeIfsc(input.ifsc);
    const fields: Record<string, string[]> = {};
    if (!isValidHolderName(holderName)) fields['holder_name'] = ['must be 2-100 letters, spaces and . - & \''];
    if (!isValidAccountNumber(accountNumber)) fields['account_number'] = ['must be 9-18 digits'];
    if (!isValidIfsc(ifsc)) fields['ifsc'] = ['must be a valid IFSC code (4 letters, 0, 6 letters/digits)'];
    if (Object.keys(fields).length) throw new ValidationFailedError('Invalid bank details', { fields });

    const hash = hmacSha256Hex(this.config.piiHashKey, `${ifsc}:${accountNumber}`);
    try {
      return await this.uow.run(async () => {
        const now = this.clock.now();
        const current = await this.db
          .selectFrom('settlement.payout_accounts')
          .selectAll()
          .where('provider_id', '=', providerId)
          .where('status', 'in', ['PENDING_VERIFICATION', 'VERIFIED'])
          .forUpdate()
          .executeTakeFirst();
        if (current && current.account_hash === hash) return this.toView(current); // the same account again: nothing to do

        const recent = await this.db
          .selectFrom('settlement.payout_accounts')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('provider_id', '=', providerId)
          .where('created_at', '>', new Date(now.getTime() - 86_400_000))
          .executeTakeFirstOrThrow();
        if (Number(recent.n) >= MAX_CHANGES_PER_DAY) throw new TooManyRequestsError('Too many bank account changes today; try again tomorrow');

        if (current) await this.db.updateTable('settlement.payout_accounts').set({ status: 'REPLACED', updated_at: now }).where('id', '=', current.id).execute();
        const id = uuidv7();
        await this.db
          .insertInto('settlement.payout_accounts')
          .values({
            id,
            provider_id: providerId,
            holder_name_enc: this.cipher.encrypt(holderName),
            account_number_enc: this.cipher.encrypt(accountNumber),
            ifsc,
            account_last4: accountNumber.slice(-4),
            account_hash: hash,
            verification_ref: `bankcheck-${id}`,
            failure_reason: null,
            verified_at: null,
            created_by: userId,
            created_at: now,
            updated_at: now,
          })
          .execute();
        // Never the number or the name: ids, the IFSC and the last four digits only.
        await this.audit.record({ actorType: 'USER', actorId: userId, action: 'payout_account.set', entityType: 'payout_account', entityId: id, after: { provider_id: providerId, ifsc, last4: accountNumber.slice(-4), replaced: current?.id ?? null } });
        await this.outbox.publish({ type: 'settlement.bank_verification_requested', aggregateType: 'payout_account', aggregateId: id, payload: { payout_account_id: id } });
        if (current) await this.outbox.publish({ type: 'settlement.payout_account_changed', aggregateType: 'provider', aggregateId: providerId, payload: { provider_id: providerId, payout_account_id: id } });
        return this.toView(await this.db.selectFrom('settlement.payout_accounts').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
      });
    } catch (err) {
      if (pgConstraint(err) === 'payout_accounts_one_live') throw new ConflictError('PAYOUT_ACCOUNT_CONFLICT', 'The bank account was changed at the same moment; please retry');
      throw err;
    }
  }

  /** The provider's current account (live, or the last one that failed verification), or null. */
  async getFor(userId: string, providerId: string): Promise<PayoutAccountView | null> {
    await this.access.require(userId, 'payout_account:manage', providerId);
    return this.current(providerId);
  }

  async current(providerId: string): Promise<PayoutAccountView | null> {
    const row = await this.db.selectFrom('settlement.payout_accounts').selectAll().where('provider_id', '=', providerId).where('status', '<>', 'REPLACED').orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    return row ? this.toView(row) : null;
  }

  async list(opts: { status?: AccountStatus; providerId?: string; limit: number; cursor?: string }): Promise<{ data: PayoutAccountView[]; nextCursor: string | null }> {
    let q = this.db.selectFrom('settlement.payout_accounts').selectAll().orderBy('id', 'desc').limit(opts.limit + 1);
    if (opts.status) q = q.where('status', '=', opts.status);
    if (opts.providerId) q = q.where('provider_id', '=', opts.providerId);
    if (opts.cursor) q = q.where('id', '<', opts.cursor);
    const rows = await q.execute();
    const page = rows.slice(0, opts.limit);
    return { data: page.map((r) => this.toView(r)), nextCursor: rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  /**
   * Runs the bank check with the provider. Idempotent and safe to repeat (outbox consumer or sweeper): the provider is keyed by the
   * account's own reference. A result is only accepted while the account is still waiting for one.
   */
  async verify(accountId: string): Promise<'VERIFIED' | 'FAILED' | 'PENDING' | 'SKIPPED'> {
    // With no payout provider (the production default today) there is nobody to ask: the account simply stays pending, quietly,
    // instead of failing and burning retries. It is checked as soon as a provider is enabled (the sweeper picks it up).
    if (this.provider.name === 'disabled') return 'PENDING';
    return this.uow.run(async () => {
      const acc = await this.db.selectFrom('settlement.payout_accounts').selectAll().where('id', '=', accountId).forUpdate().executeTakeFirst();
      if (!acc || acc.status !== 'PENDING_VERIFICATION') return 'SKIPPED';

      const holderName = this.cipher.decrypt(acc.holder_name_enc);
      const result = await this.provider.verifyBankAccount({
        reference: acc.verification_ref,
        destination: { accountNumber: this.cipher.decrypt(acc.account_number_enc), ifsc: acc.ifsc, holderName },
      });
      if (result.status === 'PENDING') return 'PENDING'; // asked again later by the sweeper

      const now = this.clock.now();
      // The bank registers an account under a name. If it is not the name we were given, paying it would be paying a stranger.
      const mismatch = result.status === 'VERIFIED' && result.nameAtBank !== undefined && !namesMatch(holderName, result.nameAtBank);
      const ok = result.status === 'VERIFIED' && !mismatch;
      const reason = ok ? null : mismatch ? 'NAME_MISMATCH' : (result.failureReason ?? 'VERIFICATION_FAILED').slice(0, 100);
      await this.db
        .updateTable('settlement.payout_accounts')
        .set({ status: ok ? 'VERIFIED' : 'VERIFICATION_FAILED', verified_at: ok ? now : null, failure_reason: reason, updated_at: now })
        .where('id', '=', acc.id)
        .execute();
      await this.audit.record({ actorType: 'SYSTEM', action: ok ? 'payout_account.verified' : 'payout_account.verification_failed', entityType: 'payout_account', entityId: acc.id, after: { provider_id: acc.provider_id, reason } });
      await this.outbox.publish({ type: ok ? 'settlement.payout_account_verified' : 'settlement.payout_account_verification_failed', aggregateType: 'payout_account', aggregateId: acc.id, payload: { payout_account_id: acc.id, provider_id: acc.provider_id, reason } });
      return ok ? 'VERIFIED' : 'FAILED';
    });
  }

  /** Decrypts the destination for ONE provider call. Callers must not log or persist it. */
  destinationOf(acc: PayoutAccountRow) {
    return { accountNumber: this.cipher.decrypt(acc.account_number_enc), ifsc: acc.ifsc, holderName: this.cipher.decrypt(acc.holder_name_enc) };
  }

  async mustFind(accountId: string): Promise<PayoutAccountRow> {
    const row = await this.db.selectFrom('settlement.payout_accounts').selectAll().where('id', '=', accountId).executeTakeFirst();
    if (!row) throw new NotFoundError('Payout account');
    return row;
  }

  private toView(r: PayoutAccountRow): PayoutAccountView {
    return {
      id: r.id,
      provider_id: r.provider_id,
      holder_name: this.cipher.decrypt(r.holder_name_enc),
      ifsc: r.ifsc,
      account_number: maskAccountNumber(r.account_last4),
      status: r.status,
      failure_reason: r.failure_reason,
      verified_at: r.verified_at ? r.verified_at.toISOString() : null,
      created_at: r.created_at.toISOString(),
    };
  }
}
