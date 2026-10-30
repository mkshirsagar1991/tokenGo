import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  APP_CONFIG,
  AppConfig,
  Clock,
  ConflictError,
  DomainError,
  Money,
  NotFoundError,
  OutboxService,
  UnitOfWork,
  uuidv7,
} from '../../../shared-kernel';
import { HoldAlreadyClosedError, InsufficientFundsError, LedgerInvariantError } from '../domain/errors';
import type { LedgerDb } from '../infrastructure/db-types';
import { LedgerPoster, PostingLine } from './ledger-poster';

/** Fixed platform accounts (seeded by migration 8). */
export const PLATFORM_ACCOUNTS = {
  GATEWAY_CLEARING: '00000000-0000-7000-8000-000000000401',
  PLATFORM_COMMISSION: '00000000-0000-7000-8000-000000000402',
  PAYOUT_CLEARING: '00000000-0000-7000-8000-000000000403',
  REFUND_CLEARING: '00000000-0000-7000-8000-000000000404',
  ADJUSTMENT: '00000000-0000-7000-8000-000000000405',
} as const;

type Actor = { type: 'USER' | 'SYSTEM'; id?: string };

export interface WalletRef {
  customerId: string;
  currency: string;
  availableAccountId: string;
  heldAccountId: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
}

export interface HoldView {
  id: string;
  bookingId: string;
  customerId: string;
  purpose: 'BOOKING' | 'ADDITIONAL_CHARGE';
  amount: Money;
  status: 'ACTIVE' | 'RELEASED' | 'SETTLED';
  createTxnId: string;
  closeTxnId: string | null;
  closeReason: string | null;
}

/** Where a settled hold's money goes. The sum MUST equal the hold amount exactly. */
export type Allocation =
  | { kind: 'CUSTOMER_REFUND'; amount: Money }
  | { kind: 'PROVIDER_PAYABLE'; providerId: string; amount: Money }
  | { kind: 'PLATFORM_COMMISSION'; amount: Money };

/**
 * The ledger's public facade (docs §J). Only NAMED operations exist — there is no "post arbitrary entries"
 * and no API that sets a balance — so the invariants cannot be bypassed by a caller.
 *
 * All methods join the caller's transaction (Unit-of-Work). Customer money flows:
 *   top-up        DR gateway_clearing           CR customer_available
 *   hold          DR customer_available         CR customer_held
 *   release       DR customer_held              CR customer_available
 *   settle        DR customer_held              CR provider_payable [+ platform_commission] [+ customer_available]
 */
@Injectable()
export class LedgerService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    private readonly poster: LedgerPoster,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
  ) {}

  private get db() {
    return this.uow.db<LedgerDb>();
  }

  // ===== accounts & wallets ==========================================================================================
  private async ensureAccount(ownerType: 'CUSTOMER' | 'PROVIDER', ownerId: string, accountType: 'CUSTOMER_AVAILABLE' | 'CUSTOMER_HELD' | 'PROVIDER_PAYABLE', currency: string): Promise<string> {
    await this.db
      .insertInto('ledger.accounts')
      .values({ id: uuidv7(), owner_type: ownerType, owner_id: ownerId, account_type: accountType, currency, normal_side: 'CREDIT' })
      .onConflict((oc) => oc.doNothing()) // the unique identity index makes concurrent creation converge
      .execute();
    const row = await this.db
      .selectFrom('ledger.accounts')
      .select('id')
      .where('owner_type', '=', ownerType)
      .where('owner_id', '=', ownerId)
      .where('account_type', '=', accountType)
      .where('currency', '=', currency)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async ensureWallet(customerId: string, currency = 'INR'): Promise<WalletRef> {
    const existing = await this.findWallet(customerId);
    if (existing) return existing;
    const available = await this.ensureAccount('CUSTOMER', customerId, 'CUSTOMER_AVAILABLE', currency);
    const held = await this.ensureAccount('CUSTOMER', customerId, 'CUSTOMER_HELD', currency);
    await this.db
      .insertInto('ledger.wallet_accounts')
      .values({ customer_id: customerId, currency, available_account_id: available, held_account_id: held })
      .onConflict((oc) => oc.doNothing())
      .execute();
    return (await this.findWallet(customerId))!;
  }

  async findWallet(customerId: string, opts: { forUpdate?: boolean } = {}): Promise<WalletRef | undefined> {
    let q = this.db.selectFrom('ledger.wallet_accounts').selectAll().where('customer_id', '=', customerId);
    if (opts.forUpdate) q = q.forUpdate();
    const w = await q.executeTakeFirst();
    return w && { customerId: w.customer_id, currency: w.currency, availableAccountId: w.available_account_id, heldAccountId: w.held_account_id, status: w.status };
  }

  async ensureProviderPayableAccount(providerId: string, currency = 'INR'): Promise<string> {
    return this.ensureAccount('PROVIDER', providerId, 'PROVIDER_PAYABLE', currency);
  }

  /** Available + held, as the customer sees them. A customer with no wallet yet has zero of both. */
  async getBalance(customerId: string, currency = 'INR'): Promise<{ available: Money; held: Money }> {
    const wallet = await this.findWallet(customerId);
    if (!wallet) return { available: Money.zero(currency), held: Money.zero(currency) };
    const rows = await this.db.selectFrom('ledger.accounts').select(['id', 'balance_minor']).where('id', 'in', [wallet.availableAccountId, wallet.heldAccountId]).execute();
    const bal = (id: string) => Money.of(BigInt(rows.find((r) => r.id === id)?.balance_minor ?? '0'), wallet.currency);
    return { available: bal(wallet.availableAccountId), held: bal(wallet.heldAccountId) };
  }

  // ===== funding =========================================================================================================
  /** Credit for a payment the payments module has VERIFIED server-side (never a client-reported success). */
  async creditVerifiedPayment(input: { customerId: string; amount: Money; paymentRef: string; idempotencyKey: string; actor: Actor }) {
    return this.credit('TOPUP', input);
  }

  /**
   * DEVELOPMENT ONLY test funds, recorded as clearly identified `DEV_TEST_CREDIT` transactions
   * (requirements §34). Refuses to run in production.
   */
  async creditDevTestFunds(input: { customerId: string; amount: Money; paymentRef: string; idempotencyKey: string; actor: Actor }) {
    if (this.config.isProduction) throw new DomainError('DEV_ONLY', 'Test funds are not available in production', 403);
    return this.credit('DEV_TEST_CREDIT', input);
  }

  private async credit(txnType: 'TOPUP' | 'DEV_TEST_CREDIT', input: { customerId: string; amount: Money; paymentRef: string; idempotencyKey: string; actor: Actor }) {
    if (!input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Amount must be positive', 422);
    return this.uow.run(async () => {
      const wallet = await this.ensureWallet(input.customerId, input.amount.currency);
      if (wallet.status !== 'ACTIVE') throw new ConflictError('WALLET_NOT_ACTIVE', 'This wallet cannot be credited');
      const res = await this.poster.post({
        txnType,
        currency: input.amount.currency,
        lines: [
          { accountId: PLATFORM_ACCOUNTS.GATEWAY_CLEARING, direction: 'DEBIT', amountMinor: input.amount.minor },
          { accountId: wallet.availableAccountId, direction: 'CREDIT', amountMinor: input.amount.minor },
        ],
        idempotencyKey: input.idempotencyKey,
        businessRef: { type: 'payment', id: input.paymentRef },
        actor: input.actor,
        metadata: { label: txnType === 'DEV_TEST_CREDIT' ? 'DEV TEST FUNDS — not real money' : undefined },
      });
      if (res.created) await this.outbox.publish({ type: 'ledger.wallet_credited', aggregateType: 'wallet', aggregateId: input.customerId, payload: { customer_id: input.customerId, txn_id: res.txnId, amount_minor: Number(input.amount.minor), currency: input.amount.currency } });
      return res;
    });
  }

  // ===== holds ===========================================================================================================
  /**
   * Reserves funds for a booking: DR customer_available / CR customer_held, plus the hold record.
   * Locks the customer's available account so two simultaneous bookings can never spend the same money.
   * Replays with the same idempotency key return the original hold.
   */
  async createHold(input: {
    bookingId: string;
    customerId: string;
    amount: Money;
    purpose?: 'BOOKING' | 'ADDITIONAL_CHARGE';
    idempotencyKey: string;
    actor: Actor;
  }): Promise<HoldView> {
    if (!input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Hold amount must be positive', 422);
    const purpose = input.purpose ?? 'BOOKING';
    return this.uow.run(async () => {
      const wallet = await this.ensureWallet(input.customerId, input.amount.currency);
      if (wallet.status !== 'ACTIVE') throw new ConflictError('WALLET_NOT_ACTIVE', 'This wallet cannot be used right now');

      // Idempotent replay FIRST: a retry after the original succeeded must return that hold, not fail the
      // funds check (the original already consumed those funds).
      const prior = await this.db
        .selectFrom('ledger.holds as h')
        .innerJoin('ledger.transactions as t', 't.id', 'h.create_txn_id')
        .selectAll('h')
        .where('t.idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (prior) {
        if (prior.booking_id !== input.bookingId) throw new ConflictError('LEDGER_KEY_REUSED', 'This idempotency key belongs to a different booking');
        return this.toHold(prior);
      }

      // Serialise everything that spends this customer's money.
      const available = await this.poster.lockBalance(wallet.availableAccountId);
      if (available < input.amount.minor) throw new InsufficientFundsError(available, input.amount.minor, wallet.currency);

      const res = await this.poster.post({
        txnType: 'HOLD_CREATE',
        currency: wallet.currency,
        lines: [
          { accountId: wallet.availableAccountId, direction: 'DEBIT', amountMinor: input.amount.minor },
          { accountId: wallet.heldAccountId, direction: 'CREDIT', amountMinor: input.amount.minor },
        ],
        idempotencyKey: input.idempotencyKey,
        businessRef: { type: 'booking', id: input.bookingId },
        bookingId: input.bookingId,
        actor: input.actor,
      });
      if (!res.created) {
        const original = await this.db.selectFrom('ledger.holds').selectAll().where('create_txn_id', '=', res.txnId).executeTakeFirst();
        if (!original) throw new LedgerInvariantError('Replayed hold posting has no hold record');
        return this.toHold(original);
      }

      const holdId = uuidv7();
      try {
        await this.db
          .insertInto('ledger.holds')
          .values({
            id: holdId,
            booking_id: input.bookingId,
            customer_id: input.customerId,
            purpose,
            amount_minor: input.amount.minor.toString(),
            currency: wallet.currency,
            create_txn_id: res.txnId,
            close_txn_id: null,
            close_reason: null,
            created_at: this.clock.now(),
            closed_at: null,
          })
          .execute();
      } catch (err) {
        if ((err as { constraint?: string }).constraint === 'holds_active_key') {
          throw new ConflictError('HOLD_EXISTS', 'An active hold already exists for this booking');
        }
        throw err;
      }
      await this.outbox.publish({
        type: 'ledger.hold_created',
        aggregateType: 'hold',
        aggregateId: holdId,
        payload: { hold_id: holdId, booking_id: input.bookingId, customer_id: input.customerId, amount_minor: Number(input.amount.minor), currency: wallet.currency },
      });
      return this.toHold((await this.db.selectFrom('ledger.holds').selectAll().where('id', '=', holdId).executeTakeFirstOrThrow()));
    });
  }

  /**
   * Releases an ACTIVE hold back to the customer's available balance. Safe to call twice: the second call
   * returns the recorded outcome and posts nothing (a hold can be closed exactly once, docs §12).
   */
  async releaseHold(input: { holdId: string; reason: string; idempotencyKey: string; actor: Actor }): Promise<{ hold: HoldView; changed: boolean }> {
    return this.uow.run(async () => {
      const hold = await this.lockHold(input.holdId);
      if (hold.status === 'RELEASED') return { hold: this.toHold(hold), changed: false };
      if (hold.status === 'SETTLED') throw new HoldAlreadyClosedError('SETTLED');

      const wallet = (await this.findWallet(hold.customer_id))!;
      const amount = BigInt(hold.amount_minor);
      const res = await this.poster.post({
        txnType: 'HOLD_RELEASE',
        currency: hold.currency,
        lines: [
          { accountId: wallet.heldAccountId, direction: 'DEBIT', amountMinor: amount },
          { accountId: wallet.availableAccountId, direction: 'CREDIT', amountMinor: amount },
        ],
        idempotencyKey: input.idempotencyKey,
        businessRef: { type: 'booking', id: hold.booking_id },
        bookingId: hold.booking_id,
        actor: input.actor,
        metadata: { reason: input.reason },
      });
      await this.closeHold(hold.id, 'RELEASED', res.txnId, input.reason);
      await this.outbox.publish({ type: 'ledger.hold_released', aggregateType: 'hold', aggregateId: hold.id, payload: { hold_id: hold.id, booking_id: hold.booking_id, customer_id: hold.customer_id, reason: input.reason } });
      return { hold: this.toHold(await this.lockHold(hold.id)), changed: true };
    });
  }

  /**
   * Settles an ACTIVE hold: the held money leaves the customer and is allocated to the provider payable,
   * the platform commission and/or back to the customer (refund portion) in ONE balanced transaction.
   * The allocations must add up to the hold amount exactly — no money is created or lost.
   */
  async settleHold(input: { holdId: string; allocations: Allocation[]; reason: string; idempotencyKey: string; actor: Actor }): Promise<{ hold: HoldView; changed: boolean; txnId: string }> {
    return this.uow.run(async () => {
      const hold = await this.lockHold(input.holdId);
      if (hold.status === 'SETTLED' && hold.close_txn_id) return { hold: this.toHold(hold), changed: false, txnId: hold.close_txn_id };
      if (hold.status === 'RELEASED') throw new HoldAlreadyClosedError('RELEASED');

      const wallet = (await this.findWallet(hold.customer_id))!;
      const total = BigInt(hold.amount_minor);
      const live = input.allocations.filter((a) => a.amount.minor > 0n);
      if (live.some((a) => a.amount.currency !== hold.currency)) throw new LedgerInvariantError('Allocation currency mismatch');
      const allocated = live.reduce((s, a) => s + a.amount.minor, 0n);
      if (allocated !== total) throw new LedgerInvariantError(`Allocations (${allocated}) must equal the held amount (${total})`);

      const lines: PostingLine[] = [{ accountId: wallet.heldAccountId, direction: 'DEBIT', amountMinor: total }];
      for (const a of live) {
        const accountId =
          a.kind === 'CUSTOMER_REFUND' ? wallet.availableAccountId : a.kind === 'PLATFORM_COMMISSION' ? PLATFORM_ACCOUNTS.PLATFORM_COMMISSION : await this.ensureProviderPayableAccount(a.providerId, hold.currency);
        lines.push({ accountId, direction: 'CREDIT', amountMinor: a.amount.minor });
      }
      const res = await this.poster.post({
        txnType: 'HOLD_SETTLE',
        currency: hold.currency,
        lines,
        idempotencyKey: input.idempotencyKey,
        businessRef: { type: 'booking', id: hold.booking_id },
        bookingId: hold.booking_id,
        actor: input.actor,
        metadata: { reason: input.reason, allocations: live.map((a) => ({ kind: a.kind, amount_minor: Number(a.amount.minor) })) },
      });
      await this.closeHold(hold.id, 'SETTLED', res.txnId, input.reason);
      await this.outbox.publish({ type: 'ledger.hold_settled', aggregateType: 'hold', aggregateId: hold.id, payload: { hold_id: hold.id, booking_id: hold.booking_id, txn_id: res.txnId, reason: input.reason } });
      // One event per provider credited by this posting, so the settlement module can record "what the provider is owed" from
      // the ledger itself — the single source of truth for every settlement path (completion, cancellation fee, no-show).
      const commission = live.filter((a) => a.kind === 'PLATFORM_COMMISSION').reduce((sum, a) => sum + a.amount.minor, 0n);
      for (const a of live) {
        if (a.kind !== 'PROVIDER_PAYABLE') continue;
        await this.outbox.publish({
          type: 'ledger.provider_payable_credited',
          aggregateType: 'ledger_transaction',
          aggregateId: res.txnId,
          payload: { provider_id: a.providerId, booking_id: hold.booking_id, txn_id: res.txnId, net_minor: Number(a.amount.minor), commission_minor: Number(commission), currency: hold.currency },
        });
      }
      return { hold: this.toHold(await this.lockHold(hold.id)), changed: true, txnId: res.txnId };
    });
  }

  /**
   * Compensating transaction: books the exact opposite of an earlier transaction and links it. Nothing is
   * edited or deleted. A transaction can be reversed once (unique index). Fails cleanly if the reversal would
   * make a protected balance negative (e.g. a payable already paid out).
   */
  async reverseTransaction(input: { txnId: string; reason: string; idempotencyKey: string; actor: Actor }): Promise<{ txnId: string; created: boolean }> {
    return this.uow.run(async () => {
      const original = await this.db.selectFrom('ledger.transactions').selectAll().where('id', '=', input.txnId).executeTakeFirst();
      if (!original) throw new NotFoundError('Transaction');
      if (original.reverses_txn_id) throw new ConflictError('CANNOT_REVERSE_A_REVERSAL', 'A reversing transaction cannot itself be reversed');
      const entries = await this.db.selectFrom('ledger.entries').selectAll().where('txn_id', '=', input.txnId).orderBy('account_seq').execute();
      try {
        return await this.poster.post({
          txnType: 'REVERSAL',
          currency: original.currency,
          lines: entries.map((e) => ({ accountId: e.account_id, direction: e.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT', amountMinor: BigInt(e.amount_minor) })),
          idempotencyKey: input.idempotencyKey,
          businessRef: original.business_ref_id ? { type: original.business_ref_type ?? 'unknown', id: original.business_ref_id } : undefined,
          bookingId: original.booking_id ?? undefined,
          reversesTxnId: original.id,
          actor: input.actor,
          metadata: { reason: input.reason, reverses: original.txn_type },
        });
      } catch (err) {
        if ((err as { constraint?: string }).constraint === 'transactions_reverses_key') {
          throw new ConflictError('ALREADY_REVERSED', 'This transaction has already been reversed');
        }
        throw err;
      }
    });
  }

  // ===== refunds to the original payment instrument (parked in REFUND_CLEARING until the PSP confirms) ===========
  /**
   * Step 1: take the money OUT of the customer's available balance and park it in REFUND_CLEARING
   * (DR customer_available / CR refund_clearing). Fails with INSUFFICIENT_FUNDS if the customer already spent it —
   * you cannot refund money that is no longer there. Locks the wallet, like every spend.
   */
  async reserveRefund(input: { customerId: string; amount: Money; refundId: string; idempotencyKey: string; actor: Actor }): Promise<{ txnId: string; created: boolean }> {
    if (!input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Amount must be positive', 422);
    return this.uow.run(async () => {
      const wallet = await this.ensureWallet(input.customerId, input.amount.currency);
      const prior = await this.db.selectFrom('ledger.transactions').select('id').where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (prior) return { txnId: prior.id, created: false };
      const available = await this.poster.lockBalance(wallet.availableAccountId);
      if (available < input.amount.minor) throw new InsufficientFundsError(available, input.amount.minor, wallet.currency);
      return this.poster.post({
        txnType: 'REFUND_RESERVE',
        currency: wallet.currency,
        lines: [
          { accountId: wallet.availableAccountId, direction: 'DEBIT', amountMinor: input.amount.minor },
          { accountId: PLATFORM_ACCOUNTS.REFUND_CLEARING, direction: 'CREDIT', amountMinor: input.amount.minor },
        ],
        idempotencyKey: input.idempotencyKey,
        businessRef: { type: 'refund', id: input.refundId },
        actor: input.actor,
      });
    });
  }

  /** Step 2 (PSP confirmed): the parked money has left the platform. DR refund_clearing / CR gateway_clearing. */
  async completeRefund(input: { refundId: string; amount: Money; idempotencyKey: string; actor: Actor }): Promise<{ txnId: string; created: boolean }> {
    return this.uow.run(() =>
      this.poster.post({
        txnType: 'REFUND_COMPLETE',
        currency: input.amount.currency,
        lines: [
          { accountId: PLATFORM_ACCOUNTS.REFUND_CLEARING, direction: 'DEBIT', amountMinor: input.amount.minor },
          { accountId: PLATFORM_ACCOUNTS.GATEWAY_CLEARING, direction: 'CREDIT', amountMinor: input.amount.minor },
        ],
        idempotencyKey: input.idempotencyKey,
        businessRef: { type: 'refund', id: input.refundId },
        actor: input.actor,
      }),
    );
  }

  /** Step 2 (PSP refused): give the money back to the customer by COMPENSATING the reservation (never an edit). */
  async abortRefund(input: { reserveTxnId: string; reason: string; idempotencyKey: string; actor: Actor }): Promise<{ txnId: string; created: boolean }> {
    return this.reverseTransaction({ txnId: input.reserveTxnId, reason: input.reason, idempotencyKey: input.idempotencyKey, actor: input.actor });
  }

  // ===== provider payouts (the provider's payable leaves via PAYOUT_CLEARING until the bank confirms) ===============
  /**
   * Step 1: DR provider_payable / CR payout_clearing. The provider can no longer be paid this money twice (it has left the
   * payable) and it is visibly "in transit", not "paid". Fails if the payable balance cannot cover it. Locks the payable account.
   */
  async reservePayout(input: { providerId: string; amount: Money; payoutId: string; idempotencyKey: string; actor: Actor }): Promise<{ txnId: string; created: boolean }> {
    if (!input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Amount must be positive', 422);
    return this.uow.run(async () => {
      const prior = await this.db.selectFrom('ledger.transactions').select('id').where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (prior) return { txnId: prior.id, created: false };
      const payable = await this.ensureProviderPayableAccount(input.providerId, input.amount.currency);
      const balance = await this.poster.lockBalance(payable);
      if (balance < input.amount.minor) {
        throw new ConflictError('PAYABLE_BALANCE_TOO_LOW', 'The provider payable balance does not cover this payout', { payable_minor: Number(balance), required_minor: Number(input.amount.minor) });
      }
      return this.poster.post({
        txnType: 'PAYOUT_RESERVE',
        currency: input.amount.currency,
        lines: [
          { accountId: payable, direction: 'DEBIT', amountMinor: input.amount.minor },
          { accountId: PLATFORM_ACCOUNTS.PAYOUT_CLEARING, direction: 'CREDIT', amountMinor: input.amount.minor },
        ],
        idempotencyKey: input.idempotencyKey,
        businessRef: { type: 'payout', id: input.payoutId },
        actor: input.actor,
      });
    });
  }

  /** Step 2 (bank confirmed): the money has left the platform. DR payout_clearing / CR gateway_clearing. */
  async completePayout(input: { payoutId: string; amount: Money; idempotencyKey: string; actor: Actor }): Promise<{ txnId: string; created: boolean }> {
    return this.uow.run(() =>
      this.poster.post({
        txnType: 'PAYOUT_COMPLETE',
        currency: input.amount.currency,
        lines: [
          { accountId: PLATFORM_ACCOUNTS.PAYOUT_CLEARING, direction: 'DEBIT', amountMinor: input.amount.minor },
          { accountId: PLATFORM_ACCOUNTS.GATEWAY_CLEARING, direction: 'CREDIT', amountMinor: input.amount.minor },
        ],
        idempotencyKey: input.idempotencyKey,
        businessRef: { type: 'payout', id: input.payoutId },
        actor: input.actor,
      }),
    );
  }

  /** Step 2 (bank refused / reversed before paying): put the money back on the provider's payable by COMPENSATING the reservation. */
  async abortPayout(input: { reserveTxnId: string; reason: string; idempotencyKey: string; actor: Actor }): Promise<{ txnId: string; created: boolean }> {
    return this.reverseTransaction({ txnId: input.reserveTxnId, reason: input.reason, idempotencyKey: input.idempotencyKey, actor: input.actor });
  }

  /** Payable balances for several providers at once (providers with no account yet are simply absent). Read-only. */
  async getProviderPayableBalances(providerIds: string[], currency = 'INR'): Promise<Map<string, bigint>> {
    if (providerIds.length === 0) return new Map();
    const rows = await this.db.selectFrom('ledger.accounts').select(['owner_id', 'balance_minor']).where('owner_type', '=', 'PROVIDER').where('account_type', '=', 'PROVIDER_PAYABLE').where('currency', '=', currency).where('owner_id', 'in', providerIds).execute();
    return new Map(rows.map((r) => [r.owner_id!, BigInt(r.balance_minor)]));
  }

  /** Every provider payable account that currently holds money. Read-only; for reconciliation of the payables read model. */
  async listProviderPayableBalances(currency = 'INR'): Promise<Map<string, bigint>> {
    const rows = await this.db.selectFrom('ledger.accounts').select(['owner_id', 'balance_minor']).where('owner_type', '=', 'PROVIDER').where('account_type', '=', 'PROVIDER_PAYABLE').where('currency', '=', currency).where('balance_minor', '>', '0').execute();
    return new Map(rows.map((r) => [r.owner_id!, BigInt(r.balance_minor)]));
  }

  /** A platform account's balance (e.g. PAYOUT_CLEARING). */
  async getPlatformAccountBalance(accountId: string): Promise<bigint> {
    const row = await this.db.selectFrom('ledger.accounts').select('balance_minor').where('id', '=', accountId).where('owner_type', '=', 'PLATFORM').executeTakeFirst();
    return BigInt(row?.balance_minor ?? '0');
  }

  /** What the platform owes the provider right now (not yet in a payout). */
  async getProviderPayableBalance(providerId: string, currency = 'INR'): Promise<Money> {
    const row = await this.db
      .selectFrom('ledger.accounts')
      .select('balance_minor')
      .where('owner_type', '=', 'PROVIDER')
      .where('owner_id', '=', providerId)
      .where('account_type', '=', 'PROVIDER_PAYABLE')
      .where('currency', '=', currency)
      .executeTakeFirst();
    return Money.of(BigInt(row?.balance_minor ?? '0'), currency);
  }

  // ===== reads ============================================================================================================
  async findHold(holdId: string): Promise<HoldView | undefined> {
    const row = await this.db.selectFrom('ledger.holds').selectAll().where('id', '=', holdId).executeTakeFirst();
    return row && this.toHold(row);
  }

  async findActiveHoldForBooking(bookingId: string, purpose: 'BOOKING' | 'ADDITIONAL_CHARGE' = 'BOOKING'): Promise<HoldView | undefined> {
    const row = await this.db.selectFrom('ledger.holds').selectAll().where('booking_id', '=', bookingId).where('purpose', '=', purpose).where('status', '=', 'ACTIVE').executeTakeFirst();
    return row && this.toHold(row);
  }

  /** The customer's wallet statement: every posting that touched available or held, newest first. */
  async listWalletEntries(customerId: string, opts: { limit: number; beforeEntryId?: string }) {
    const wallet = await this.findWallet(customerId);
    if (!wallet) return [];
    const result = await sql<{
      entry_id: string;
      txn_id: string;
      txn_type: string;
      booking_id: string | null;
      account: 'AVAILABLE' | 'HELD';
      direction: 'DEBIT' | 'CREDIT';
      amount_minor: string;
      balance_after_minor: string;
      posted_at: Date;
      metadata: Record<string, unknown>;
    }>`
      SELECT e.id AS entry_id, e.txn_id, t.txn_type, t.booking_id,
             CASE WHEN e.account_id = ${wallet.availableAccountId}::uuid THEN 'AVAILABLE' ELSE 'HELD' END AS account,
             e.direction, e.amount_minor::text, e.balance_after_minor::text, t.posted_at,
             t.audit_metadata AS metadata
        FROM ledger.entries e
        JOIN ledger.transactions t ON t.id = e.txn_id
       WHERE e.account_id IN (${wallet.availableAccountId}::uuid, ${wallet.heldAccountId}::uuid)
         AND (${opts.beforeEntryId ?? null}::uuid IS NULL OR e.id < ${opts.beforeEntryId ?? null}::uuid)
       ORDER BY e.id DESC
       LIMIT ${opts.limit}`.execute(this.db);
    return result.rows.map((r) => ({ ...r, currency: wallet.currency }));
  }

  // ===== internals ========================================================================================================
  private async lockHold(holdId: string) {
    const hold = await this.db.selectFrom('ledger.holds').selectAll().where('id', '=', holdId).forUpdate().executeTakeFirst();
    if (!hold) throw new NotFoundError('Hold');
    return hold;
  }

  private async closeHold(holdId: string, status: 'RELEASED' | 'SETTLED', txnId: string, reason: string): Promise<void> {
    // Compare-and-set: only an ACTIVE hold can be closed. Zero rows means someone else closed it first.
    const res = await this.db
      .updateTable('ledger.holds')
      .set({ status, close_txn_id: txnId, close_reason: reason, closed_at: this.clock.now() })
      .where('id', '=', holdId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new HoldAlreadyClosedError('closed concurrently');
  }

  private toHold(h: { id: string; booking_id: string; customer_id: string; purpose: 'BOOKING' | 'ADDITIONAL_CHARGE'; amount_minor: string; currency: string; status: 'ACTIVE' | 'RELEASED' | 'SETTLED'; create_txn_id: string; close_txn_id: string | null; close_reason: string | null }): HoldView {
    return {
      id: h.id,
      bookingId: h.booking_id,
      customerId: h.customer_id,
      purpose: h.purpose,
      amount: Money.of(BigInt(h.amount_minor), h.currency),
      status: h.status,
      createTxnId: h.create_txn_id,
      closeTxnId: h.close_txn_id,
      closeReason: h.close_reason,
    };
  }
}
