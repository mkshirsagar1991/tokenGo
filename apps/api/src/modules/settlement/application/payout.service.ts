import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { AuditService } from '../../audit';
import { ProviderDirectoryService } from '../../provider-management';
import { LedgerService } from '../../wallet-ledger';
import {
  APP_CONFIG,
  AppConfig,
  Clock,
  ConflictError,
  DatabaseService,
  NotFoundError,
  LOGGER,
  Money,
  OutboxService,
  UnitOfWork,
  uuidv7,
} from '../../../shared-kernel';
import { PayoutProvider, PayoutRejectedError, ProviderPayout } from '../domain/payout-provider';
import { pickBatch, retryDelayHours } from '../domain/payout-rules';
import type { PayoutAccountRow, PayoutRow, SettlementDb } from '../infrastructure/db-types';
import { PayoutAccountService } from './payout-account.service';

const SYSTEM = { type: 'SYSTEM' } as const;
const CANDIDATE_PROVIDERS_PER_RUN = 200;
const PAYABLES_PER_PAYOUT = 500;
/** The sweeper only touches things at least this old, so it never races the normal, fast path. */
const SWEEP_MIN_AGE_MS = 2 * 60_000;
const SWEEP_BATCH = 100;

export type SkipReason = 'PAYOUTS_DISABLED' | 'PAUSED' | 'PROVIDER_NOT_APPROVED' | 'NO_VERIFIED_ACCOUNT' | 'ACCOUNT_COOLING_OFF' | 'PAYOUT_IN_FLIGHT' | 'BELOW_MINIMUM' | 'LEDGER_MISMATCH';

export type PayoutApplyOutcome = 'SUBMITTED' | 'PAID' | 'FAILED' | 'ALREADY_FINAL' | 'NEEDS_REVIEW' | 'STILL_PENDING';

/**
 * Pays what providers are owed, safely.
 *
 *   1. RESERVE   one transaction: pick eligible payables (row-locked, SKIP LOCKED — two workers can never pick the same money),
 *                post DR provider_payable / CR payout_clearing, create the payout, mark the payables IN_PAYOUT.
 *   2. SUBMIT    AFTER that commits, by an outbox consumer. The provider is keyed by OUR reference (the payout id) and is ALWAYS asked
 *                "do you already have this reference?" before anything is created — a timeout means UNKNOWN, resolved by lookup,
 *                never by sending again (critical test #7).
 *   3. SETTLE    the provider's confirmed state decides: PAID -> DR payout_clearing / CR gateway_clearing; FAILED/REVERSED -> a
 *                compensating reversal puts the money back on the provider's payable, retried later in a NEW payout.
 * Anything that contradicts the books after a terminal state (e.g. "paid" for a payout we already failed) is NEVER auto-corrected:
 * it flags the payout for review and pauses that provider's payouts.
 */
@Injectable()
export class PayoutService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly uow: UnitOfWork,
    private readonly database: DatabaseService,
    private readonly clock: Clock,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly provider: PayoutProvider,
    private readonly accounts: PayoutAccountService,
    private readonly directory: ProviderDirectoryService,
  ) {}

  private get db() {
    return this.uow.db<SettlementDb>();
  }

  // ===== 1. RESERVE ===================================================================================================
  /** Creates payouts for every provider that is owed at least the minimum and is allowed to be paid. Safe to run concurrently. */
  async runBatch(): Promise<{ payouts: number; considered: number; skipped: Partial<Record<SkipReason, number>> }> {
    const skipped: Partial<Record<SkipReason, number>> = {};
    if (this.provider.name === 'disabled') return { payouts: 0, considered: 0, skipped: { PAYOUTS_DISABLED: 1 } };

    const now = this.clock.now();
    const candidates = await this.db
      .selectFrom('settlement.provider_payables')
      .select(['provider_id', (eb) => eb.fn.sum<string>('net_minor').as('total')])
      .where('status', '=', 'ACCRUED')
      .where('eligible_at', '<=', now)
      .where('currency', '=', 'INR')
      .groupBy('provider_id')
      .having((eb) => eb.fn.sum('net_minor'), '>=', this.config.payouts.minMinor.toString())
      .orderBy('provider_id')
      .limit(CANDIDATE_PROVIDERS_PER_RUN)
      .execute();

    let created = 0;
    for (const c of candidates) {
      try {
        const outcome = await this.createFor(c.provider_id);
        if (outcome === 'CREATED') created += 1;
        else skipped[outcome] = (skipped[outcome] ?? 0) + 1;
      } catch (err) {
        this.logger.error({ provider_id: c.provider_id, err }, 'payout batch: provider failed');
      }
    }
    return { payouts: created, considered: candidates.length, skipped };
  }

  /** Why this provider cannot be paid right now (first reason), or null. Read-only; also used to tell providers why they are waiting. */
  async blockerFor(providerId: string, eligibleTotal: bigint): Promise<{ reason: SkipReason | null; account: PayoutAccountRow | null }> {
    const now = this.clock.now();
    if (this.provider.name === 'disabled') return { reason: 'PAYOUTS_DISABLED', account: null };
    if (await this.db.selectFrom('settlement.payout_holds').select('provider_id').where('provider_id', '=', providerId).executeTakeFirst()) return { reason: 'PAUSED', account: null };
    if ((await this.directory.getProviderStatus(providerId)) !== 'APPROVED') return { reason: 'PROVIDER_NOT_APPROVED', account: null };
    const account = (await this.db.selectFrom('settlement.payout_accounts').selectAll().where('provider_id', '=', providerId).where('status', '=', 'VERIFIED').executeTakeFirst()) ?? null;
    if (!account) return { reason: 'NO_VERIFIED_ACCOUNT', account: null };
    const coolingEnds = account.verified_at ? account.verified_at.getTime() + this.config.payouts.accountCoolingHours * 3_600_000 : Infinity;
    if (coolingEnds > now.getTime()) return { reason: 'ACCOUNT_COOLING_OFF', account };
    if (await this.db.selectFrom('settlement.payouts').select('id').where('provider_id', '=', providerId).where('status', 'in', ['RESERVED', 'SUBMITTED']).executeTakeFirst()) return { reason: 'PAYOUT_IN_FLIGHT', account };
    if (eligibleTotal < this.config.payouts.minMinor) return { reason: 'BELOW_MINIMUM', account };
    return { reason: null, account };
  }

  private async createFor(providerId: string): Promise<'CREATED' | SkipReason> {
    return this.uow.run(async () => {
      const now = this.clock.now();
      // One payout creation per provider at a time: without this two concurrent runs could each lock DISJOINT payables and both
      // pass the "nothing in flight" check before either commits. Released automatically at commit/rollback.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${providerId}, 12)::bigint)`.execute(this.db);
      // Lock the money FIRST. A concurrent run skips these rows instead of waiting, so the same payable can never be in two payouts.
      const rows = await this.db
        .selectFrom('settlement.provider_payables')
        .select(['id', 'net_minor'])
        .where('provider_id', '=', providerId)
        .where('status', '=', 'ACCRUED')
        .where('eligible_at', '<=', now)
        .where('currency', '=', 'INR')
        .orderBy('eligible_at')
        .orderBy('id')
        .limit(PAYABLES_PER_PAYOUT)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return 'BELOW_MINIMUM';

      const eligibleTotal = rows.reduce((s, r) => s + BigInt(r.net_minor), 0n);
      const { reason, account } = await this.blockerFor(providerId, eligibleTotal);
      if (reason || !account) return reason ?? 'NO_VERIFIED_ACCOUNT';

      const batch = pickBatch(rows.map((r) => ({ id: r.id, netMinor: BigInt(r.net_minor) })), this.config.payouts.maxMinor);
      if (batch.total < this.config.payouts.minMinor) return 'BELOW_MINIMUM';

      const payoutId = uuidv7();
      let reserveTxnId: string;
      try {
        ({ txnId: reserveTxnId } = await this.ledger.reservePayout({ providerId, amount: Money.of(batch.total, 'INR'), payoutId, idempotencyKey: `payout-reserve:${payoutId}`, actor: SYSTEM }));
      } catch (err) {
        if (err instanceof ConflictError && err.code === 'PAYABLE_BALANCE_TOO_LOW') {
          // The payable rows say we owe more than the ledger holds. That is a bookkeeping defect: pay NOTHING and say so loudly.
          await this.audit.record({ actorType: 'SYSTEM', action: 'payout.skipped_ledger_mismatch', entityType: 'provider', entityId: providerId, after: { payables_minor: batch.total, ...(err.details ?? {}) } });
          await this.outbox.publish({ type: 'settlement.payable_ledger_mismatch', aggregateType: 'provider', aggregateId: providerId, payload: { provider_id: providerId } });
          return 'LEDGER_MISMATCH';
        }
        throw err;
      }

      await this.db
        .insertInto('settlement.payouts')
        .values({
          id: payoutId,
          provider_id: providerId,
          payout_account_id: account.id,
          currency: 'INR',
          amount_minor: batch.total.toString(),
          provider_name: this.provider.name,
          provider_reference: payoutId, // OUR reference: the provider's idempotency key for this transfer
          provider_payout_id: null,
          utr: null,
          provider_created_at: null,
          last_error: null,
          failure_reason: null,
          reserve_txn_id: reserveTxnId,
          close_txn_id: null,
          created_at: now,
          submitted_at: null,
          completed_at: null,
          updated_at: now,
        })
        .execute();
      await this.db.updateTable('settlement.provider_payables').set({ status: 'IN_PAYOUT', payout_id: payoutId, updated_at: now }).where('id', 'in', batch.ids).execute();
      await this.db.insertInto('settlement.payout_items').values(batch.ids.map((payableId) => ({ payout_id: payoutId, payable_id: payableId }))).execute();
      await this.audit.record({ actorType: 'SYSTEM', action: 'payout.created', entityType: 'payout', entityId: payoutId, after: { provider_id: providerId, amount_minor: batch.total, payables: batch.ids.length } });
      // The provider is called by a consumer AFTER this commits — never from inside a transaction that could still roll back.
      await this.outbox.publish({ type: 'settlement.payout_requested', aggregateType: 'payout', aggregateId: payoutId, payload: { payout_id: payoutId } });
      return 'CREATED';
    });
  }

  // ===== 2. SUBMIT (query before create) =============================================================================
  /**
   * Gets the payout to the provider and records what the provider says. Idempotent and safe to run any number of times from the
   * outbox consumer, the sweeper or an operator: it ALWAYS asks the provider for our reference first.
   */
  async submit(payoutId: string): Promise<PayoutApplyOutcome | 'SKIPPED'> {
    const p = await this.db.selectFrom('settlement.payouts').selectAll().where('id', '=', payoutId).executeTakeFirst();
    if (!p || (p.status !== 'RESERVED' && p.status !== 'SUBMITTED')) return 'SKIPPED';

    let pp: ProviderPayout | null;
    try {
      pp = await this.provider.fetchPayoutByReference(p.provider_reference); // "do you already have this?"
      if (!pp) {
        const account = await this.accounts.mustFind(p.payout_account_id);
        pp = await this.provider.createPayout({ reference: p.provider_reference, amountMinor: BigInt(p.amount_minor), currency: p.currency, destination: this.accounts.destinationOf(account) });
      }
    } catch (err) {
      if (err instanceof PayoutRejectedError) {
        // A DEFINITIVE refusal (not a timeout): the transfer did not and will not happen, so the money goes back.
        return this.uow.run(async () => {
          const locked = await this.lock(payoutId);
          return locked.status === 'RESERVED' || locked.status === 'SUBMITTED' ? this.fail(locked, `REJECTED_BY_PROVIDER: ${err.code}`) : 'ALREADY_FINAL';
        });
      }
      await this.noteAttemptFailed(payoutId, err); // visible to operators even though the caller's transaction will roll back
      throw err; // UNKNOWN outcome: retried later, and the lookup above is how the retry finds out what really happened
    }
    return this.applyProviderPayout(payoutId, pp);
  }

  // ===== 3. SETTLE ====================================================================================================
  /** Applies the provider's current view of a payout to the books. Idempotent. */
  async applyProviderPayout(payoutId: string, pp: ProviderPayout): Promise<PayoutApplyOutcome> {
    return this.uow.run(async () => {
      const p = await this.lock(payoutId);
      const now = this.clock.now();
      if (pp.provider !== p.provider_name || pp.reference !== p.provider_reference) throw new Error(`Payout ${p.id}: the provider record does not match our reference`);

      if (pp.amountMinor !== BigInt(p.amount_minor) || pp.currency !== p.currency) {
        // Never complete or fail a payout on the strength of a record that disagrees about the AMOUNT.
        return this.flagForReview(p, `AMOUNT_MISMATCH: ours ${p.amount_minor}, provider ${pp.amountMinor}`);
      }
      if (!p.provider_payout_id) {
        await this.db.updateTable('settlement.payouts').set({ provider_payout_id: pp.payoutId, provider_created_at: pp.createdAt, updated_at: now }).where('id', '=', p.id).execute();
      }

      switch (pp.status) {
        case 'QUEUED':
        case 'PROCESSING': {
          if (p.status === 'RESERVED') {
            await this.db.updateTable('settlement.payouts').set({ status: 'SUBMITTED', submitted_at: now, last_error: null, updated_at: now }).where('id', '=', p.id).execute();
            return 'SUBMITTED';
          }
          // We have already called it PAID or FAILED, yet the provider still has it live: the books and the bank disagree.
          return p.status === 'SUBMITTED' ? 'STILL_PENDING' : this.flagForReview(p, `STILL_${pp.status}_AT_PROVIDER_AFTER_${p.status}`);
        }
        case 'PAID': {
          if (p.status === 'PAID') return 'ALREADY_FINAL';
          // Paid at the bank but we already returned the money to the provider's payable: a double-payment risk. Freeze and flag.
          if (p.status === 'FAILED') return this.flagForReview(p, 'PAID_AT_PROVIDER_AFTER_FAILED', true);
          const close = await this.ledger.completePayout({ payoutId: p.id, amount: Money.of(BigInt(p.amount_minor), p.currency), idempotencyKey: `payout-complete:${p.id}`, actor: SYSTEM });
          await this.db.updateTable('settlement.provider_payables').set({ status: 'PAID', updated_at: now }).where('payout_id', '=', p.id).execute();
          await this.db.updateTable('settlement.payouts').set({ status: 'PAID', utr: pp.utr ?? null, close_txn_id: close.txnId, completed_at: now, last_error: null, updated_at: now }).where('id', '=', p.id).execute();
          await this.audit.record({ actorType: 'SYSTEM', action: 'payout.paid', entityType: 'payout', entityId: p.id, after: { provider_id: p.provider_id, amount_minor: p.amount_minor, utr: pp.utr ?? null } });
          await this.outbox.publish({ type: 'settlement.payout_paid', aggregateType: 'payout', aggregateId: p.id, payload: { payout_id: p.id, provider_id: p.provider_id, amount_minor: Number(p.amount_minor), currency: p.currency } });
          return 'PAID';
        }
        case 'FAILED':
        case 'REVERSED': {
          if (p.status === 'FAILED') return 'ALREADY_FINAL';
          // The bank sent the money BACK after we recorded it as paid: platform cash and our books now disagree. A human decides.
          if (p.status === 'PAID') return this.flagForReview(p, `${pp.status}_AT_PROVIDER_AFTER_PAID`, true);
          return this.fail(p, `${pp.status}_AT_PROVIDER${pp.failureReason ? `: ${pp.failureReason}` : ''}`);
        }
      }
    });
  }

  /** The provider will not pay: compensate the reservation, return the payables to ACCRUED (retry later), pause on repeated failure. */
  private async fail(p: PayoutRow, reason: string): Promise<PayoutApplyOutcome> {
    const now = this.clock.now();
    const back = await this.ledger.abortPayout({ reserveTxnId: p.reserve_txn_id!, reason, idempotencyKey: `payout-abort:${p.id}`, actor: SYSTEM });
    await this.db.updateTable('settlement.payouts').set({ status: 'FAILED', failure_reason: reason.slice(0, 300), close_txn_id: back.txnId, completed_at: now, updated_at: now }).where('id', '=', p.id).execute();

    // How many payouts in a row have failed for this provider (this one included)? The money waits longer each time.
    const recent = await this.db.selectFrom('settlement.payouts').select('status').where('provider_id', '=', p.provider_id).where('status', 'in', ['PAID', 'FAILED']).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(this.config.payouts.maxConsecutiveFailures).execute();
    let consecutive = 0;
    for (const r of recent) {
      if (r.status !== 'FAILED') break;
      consecutive += 1;
    }
    await this.db
      .updateTable('settlement.provider_payables')
      .set({ status: 'ACCRUED', payout_id: null, eligible_at: new Date(now.getTime() + retryDelayHours(consecutive) * 3_600_000), updated_at: now })
      .where('payout_id', '=', p.id)
      .execute();

    await this.audit.record({ actorType: 'SYSTEM', action: 'payout.failed', entityType: 'payout', entityId: p.id, after: { provider_id: p.provider_id, amount_minor: p.amount_minor, reason, consecutive_failures: consecutive } });
    await this.outbox.publish({ type: 'settlement.payout_failed', aggregateType: 'payout', aggregateId: p.id, payload: { payout_id: p.id, provider_id: p.provider_id, reason } });
    if (consecutive >= this.config.payouts.maxConsecutiveFailures) await this.pause(p.provider_id, `AUTOMATIC: ${consecutive} consecutive payout failures`, null, true);
    return 'FAILED';
  }

  private async flagForReview(p: PayoutRow, reason: string, pauseProvider = false): Promise<PayoutApplyOutcome> {
    await this.db.updateTable('settlement.payouts').set({ needs_review: true, last_error: reason.slice(0, 300), updated_at: this.clock.now() }).where('id', '=', p.id).execute();
    await this.audit.record({ actorType: 'SYSTEM', action: 'payout.needs_review', entityType: 'payout', entityId: p.id, after: { provider_id: p.provider_id, reason } });
    await this.outbox.publish({ type: 'settlement.payout_needs_review', aggregateType: 'payout', aggregateId: p.id, payload: { payout_id: p.id, provider_id: p.provider_id, reason } });
    if (pauseProvider) await this.pause(p.provider_id, `AUTOMATIC: payout ${p.id} ${reason}`, null, true);
    return 'NEEDS_REVIEW';
  }

  // ===== operators ====================================================================================================
  async freeze(providerId: string, reason: string, actorId: string): Promise<void> {
    if (!(await this.directory.providerExists(providerId))) throw new NotFoundError('Provider');
    await this.uow.run(async () => {
      await this.pause(providerId, reason.slice(0, 300), actorId, false);
    });
  }

  async unfreeze(providerId: string, actorId: string): Promise<boolean> {
    return this.uow.run(async () => {
      const res = await this.db.deleteFrom('settlement.payout_holds').where('provider_id', '=', providerId).executeTakeFirst();
      const removed = Number(res.numDeletedRows ?? 0) > 0;
      if (removed) await this.audit.record({ actorType: 'USER', actorId, action: 'payout.provider_unfrozen', entityType: 'provider', entityId: providerId });
      return removed;
    });
  }

  private async pause(providerId: string, reason: string, actorId: string | null, automatic: boolean): Promise<void> {
    const res = await this.db.insertInto('settlement.payout_holds').values({ provider_id: providerId, reason, held_by: actorId, automatic, created_at: this.clock.now() }).onConflict((oc) => oc.column('provider_id').doNothing()).executeTakeFirst();
    if (Number(res.numInsertedOrUpdatedRows ?? 0) === 0) return; // already paused
    await this.audit.record({ actorType: actorId ? 'USER' : 'SYSTEM', actorId, action: 'payout.provider_frozen', entityType: 'provider', entityId: providerId, after: { reason, automatic } });
    await this.outbox.publish({ type: 'settlement.provider_payouts_frozen', aggregateType: 'provider', aggregateId: providerId, payload: { provider_id: providerId, automatic } });
  }

  // ===== safety net (worker) ==========================================================================================
  /** Re-drives payouts and bank checks whose normal path stalled. Idempotent; safe on several workers at once. */
  async sweep(): Promise<{ payouts: number; accounts: number }> {
    if (this.provider.name === 'disabled') return { payouts: 0, accounts: 0 };
    const cutoff = new Date(this.clock.now().getTime() - SWEEP_MIN_AGE_MS);

    const open = await this.db.selectFrom('settlement.payouts').select('id').where('status', 'in', ['RESERVED', 'SUBMITTED']).where('created_at', '<', cutoff).orderBy('created_at').limit(SWEEP_BATCH).execute();
    let payouts = 0;
    for (const { id } of open) {
      try {
        await this.submit(id);
        payouts += 1;
      } catch (err) {
        this.logger.warn({ payout_id: id, err }, 'payout sweep: payout check failed');
      }
    }

    const pending = await this.db.selectFrom('settlement.payout_accounts').select('id').where('status', '=', 'PENDING_VERIFICATION').where('created_at', '<', cutoff).orderBy('created_at').limit(SWEEP_BATCH).execute();
    let accounts = 0;
    for (const { id } of pending) {
      try {
        await this.accounts.verify(id);
        accounts += 1;
      } catch (err) {
        this.logger.warn({ payout_account_id: id, err }, 'payout sweep: bank check failed');
      }
    }
    return { payouts, accounts };
  }

  /** What the worker runs on a timer: first pay what is due, then re-drive whatever is stuck. */
  async tick(): Promise<{ batch: Awaited<ReturnType<PayoutService['runBatch']>>; sweep: Awaited<ReturnType<PayoutService['sweep']>> }> {
    const batch = await this.runBatch();
    const sweep = await this.sweep();
    return { batch, sweep };
  }

  // ===== internals ====================================================================================================
  private async lock(payoutId: string): Promise<PayoutRow> {
    return this.db.selectFrom('settlement.payouts').selectAll().where('id', '=', payoutId).forUpdate().executeTakeFirstOrThrow();
  }

  /** Records a failed attempt on its OWN connection, so it survives the caller's rollback. Never stores request data. */
  private async noteAttemptFailed(payoutId: string, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    try {
      await sql`UPDATE settlement.payouts SET attempts = attempts + 1, last_error = ${message}, updated_at = ${this.clock.now()} WHERE id = ${payoutId} AND status IN ('RESERVED', 'SUBMITTED')`.execute(this.database.kysely);
    } catch (e) {
      this.logger.warn({ payout_id: payoutId, err: e }, 'could not record a failed payout attempt');
    }
  }
}
