import { Injectable } from '@nestjs/common';
import {
  Clock,
  ConflictError,
  PG_CHECK_VIOLATION,
  UnitOfWork,
  currentRequestId,
  pgErrorCode,
  uuidv7,
} from '../../../shared-kernel';
import { LedgerInvariantError } from '../domain/errors';
import type { LedgerDb } from '../infrastructure/db-types';

export interface PostingLine {
  accountId: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: bigint;
}

export interface PostSpec {
  txnType: string;
  currency: string;
  lines: PostingLine[];
  /** Unique across the whole ledger. Replaying a post with the same key is a no-op that returns the original. */
  idempotencyKey: string;
  businessRef?: { type: string; id: string };
  bookingId?: string;
  reversesTxnId?: string;
  actor: { type: 'USER' | 'SYSTEM'; id?: string };
  metadata?: Record<string, unknown>;
}

export interface PostResult {
  txnId: string;
  /** false => an identical posting already existed (idempotent replay); nothing was written. */
  created: boolean;
}

/**
 * The ONLY code that writes ledger transactions/entries and maintains cached balances.
 *
 *  1. Validates the posting is balanced and well-formed BEFORE touching the database.
 *  2. Claims the idempotency key (unique index). A replay returns the original transaction.
 *  3. Locks every account involved in a FIXED order (by id) — concurrent postings can never deadlock on
 *     lock ordering — then appends entries with a per-account sequence and updates the cached balance.
 *  4. The database has the last word: deferred balance trigger, non-negative CHECKs, immutability triggers.
 *
 * Must run inside a Unit-of-Work transaction (the caller's), so the posting commits atomically with the
 * business change that caused it.
 */
@Injectable()
export class LedgerPoster {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  private get db() {
    return this.uow.db<LedgerDb>();
  }

  async post(spec: PostSpec): Promise<PostResult> {
    this.validate(spec);

    const txnId = uuidv7();
    const inserted = await this.db
      .insertInto('ledger.transactions')
      .values({
        id: txnId,
        txn_type: spec.txnType,
        currency: spec.currency,
        business_ref_type: spec.businessRef?.type ?? null,
        business_ref_id: spec.businessRef?.id ?? null,
        booking_id: spec.bookingId ?? null,
        idempotency_key: spec.idempotencyKey,
        reverses_txn_id: spec.reversesTxnId ?? null,
        actor_type: spec.actor.type,
        actor_id: spec.actor.id ?? null,
        correlation_id: currentRequestId() ?? null,
        audit_metadata: JSON.stringify(spec.metadata ?? {}),
        posted_at: this.clock.now(),
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!inserted) {
      const existing = await this.db
        .selectFrom('ledger.transactions')
        .select(['id', 'txn_type', 'business_ref_id', 'currency'])
        .where('idempotency_key', '=', spec.idempotencyKey)
        .executeTakeFirstOrThrow();
      // The same key must mean the same posting; anything else is a caller bug we must not paper over.
      if (existing.txn_type !== spec.txnType || existing.currency !== spec.currency || existing.business_ref_id !== (spec.businessRef?.id ?? null)) {
        throw new ConflictError('LEDGER_KEY_REUSED', 'This ledger idempotency key was already used for a different posting');
      }
      return { txnId: existing.id, created: false };
    }

    // Lock all accounts in id order, then read them.
    const accountIds = [...new Set(spec.lines.map((l) => l.accountId))].sort();
    const accounts = await this.db
      .selectFrom('ledger.accounts')
      .select(['id', 'currency', 'normal_side', 'balance_minor', 'last_seq'])
      .where('id', 'in', accountIds)
      .orderBy('id')
      .forUpdate()
      .execute();
    if (accounts.length !== accountIds.length) throw new LedgerInvariantError('Posting references an unknown account');

    const state = new Map(accounts.map((a) => [a.id, { normal: a.normal_side, balance: BigInt(a.balance_minor), seq: BigInt(a.last_seq), currency: a.currency }]));
    for (const a of state.values()) {
      if (a.currency !== spec.currency) throw new LedgerInvariantError('Posting mixes currencies');
    }

    const entries: { id: string; txn_id: string; account_id: string; direction: 'DEBIT' | 'CREDIT'; amount_minor: string; account_seq: string; balance_after_minor: string }[] = [];
    for (const line of spec.lines) {
      const acct = state.get(line.accountId)!;
      acct.balance += line.direction === acct.normal ? line.amountMinor : -line.amountMinor;
      acct.seq += 1n;
      entries.push({
        id: uuidv7(),
        txn_id: txnId,
        account_id: line.accountId,
        direction: line.direction,
        amount_minor: line.amountMinor.toString(),
        account_seq: acct.seq.toString(),
        balance_after_minor: acct.balance.toString(),
      });
    }

    try {
      await this.db.insertInto('ledger.entries').values(entries).execute();
      for (const [id, a] of state) {
        await this.db
          .updateTable('ledger.accounts')
          .set({ balance_minor: a.balance.toString(), last_seq: a.seq.toString() })
          .where('id', '=', id)
          .execute();
      }
    } catch (err) {
      // A non-negative CHECK refused the new balance. Callers that need a friendly message (e.g. holds)
      // check funds first under the same lock; this is the database-level backstop.
      if (pgErrorCode(err) === PG_CHECK_VIOLATION) {
        throw new ConflictError('LEDGER_BALANCE_CONSTRAINT', 'The posting would make an account balance invalid', { constraint: (err as { constraint?: string }).constraint });
      }
      throw err;
    }
    return { txnId, created: true };
  }

  private validate(spec: PostSpec): void {
    if (spec.lines.length < 2) throw new LedgerInvariantError('A posting needs at least two lines');
    let debit = 0n;
    let credit = 0n;
    for (const l of spec.lines) {
      if (l.amountMinor <= 0n) throw new LedgerInvariantError('Posting lines must have positive amounts');
      if (l.direction === 'DEBIT') debit += l.amountMinor;
      else credit += l.amountMinor;
    }
    if (debit !== credit) throw new LedgerInvariantError(`Unbalanced posting: debits ${debit} != credits ${credit}`);
    if (!spec.idempotencyKey || spec.idempotencyKey.length > 200) throw new LedgerInvariantError('A valid idempotency key is required');
  }

  /** Reads an account's current balance (callers that must decide on it lock the row first). */
  async lockBalance(accountId: string): Promise<bigint> {
    const row = await this.db
      .selectFrom('ledger.accounts')
      .select('balance_minor')
      .where('id', '=', accountId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return BigInt(row.balance_minor);
  }

}
