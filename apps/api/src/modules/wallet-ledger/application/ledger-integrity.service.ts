import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { UnitOfWork } from '../../../shared-kernel';

export interface IntegrityViolation {
  check: string;
  detail: Record<string, unknown>;
}

/**
 * Reconciliation of the ledger against itself (requirements §11, §28): cached balances vs. entries,
 * sequence continuity, per-transaction balance, the trial balance, and holds vs. held balances.
 * It REPORTS; it never "fixes" anything — repairs are compensating transactions, authorised and audited.
 * Run nightly by the worker (and on demand by finance).
 */
@Injectable()
export class LedgerIntegrityService {
  constructor(private readonly uow: UnitOfWork) {}

  async check(): Promise<{ ok: boolean; checkedAt: string; violations: IntegrityViolation[] }> {
    const db = this.uow.db<unknown>();
    const violations: IntegrityViolation[] = [];
    const push = (check: string, rows: Record<string, unknown>[]) => rows.forEach((detail) => violations.push({ check, detail }));

    // 1. Cached balance == the signed sum of the account's entries (in the account's normal side)
    push(
      'ACCOUNT_BALANCE_MATCHES_ENTRIES',
      (
        await sql<{ account_id: string; cached: string; computed: string }>`
          SELECT a.id AS account_id, a.balance_minor::text AS cached,
                 COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS computed
            FROM ledger.accounts a LEFT JOIN ledger.entries e ON e.account_id = a.id
           GROUP BY a.id, a.balance_minor, a.normal_side
          HAVING a.balance_minor <> COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0)`.execute(db)
      ).rows,
    );

    // 2. Per-account sequence numbers are gapless and match last_seq
    push(
      'ACCOUNT_SEQUENCE_CONTINUITY',
      (
        await sql<{ account_id: string; last_seq: string; entries: string; max_seq: string }>`
          SELECT a.id AS account_id, a.last_seq::text, COUNT(e.id)::text AS entries, COALESCE(MAX(e.account_seq), 0)::text AS max_seq
            FROM ledger.accounts a LEFT JOIN ledger.entries e ON e.account_id = a.id
           GROUP BY a.id, a.last_seq
          HAVING a.last_seq <> COUNT(e.id) OR a.last_seq <> COALESCE(MAX(e.account_seq), 0)`.execute(db)
      ).rows,
    );

    // 3. Every transaction balances (and has >= 2 entries)
    push(
      'TRANSACTION_BALANCED',
      (
        await sql<{ txn_id: string; debits: string; credits: string }>`
          SELECT txn_id, SUM(amount_minor) FILTER (WHERE direction = 'DEBIT')::text AS debits,
                         SUM(amount_minor) FILTER (WHERE direction = 'CREDIT')::text AS credits
            FROM ledger.entries GROUP BY txn_id
          HAVING COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0) <> COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
              OR COUNT(*) < 2`.execute(db)
      ).rows,
    );
    push(
      'TRANSACTION_HAS_ENTRIES',
      (await sql<{ txn_id: string }>`SELECT t.id AS txn_id FROM ledger.transactions t LEFT JOIN ledger.entries e ON e.txn_id = t.id WHERE e.id IS NULL`.execute(db)).rows,
    );

    // 4. Trial balance: debit-normal balances == credit-normal balances, per currency
    push(
      'TRIAL_BALANCE',
      (
        await sql<{ currency: string; debit_normal: string; credit_normal: string }>`
          SELECT currency,
                 COALESCE(SUM(balance_minor) FILTER (WHERE normal_side = 'DEBIT'), 0)::text  AS debit_normal,
                 COALESCE(SUM(balance_minor) FILTER (WHERE normal_side = 'CREDIT'), 0)::text AS credit_normal
            FROM ledger.accounts GROUP BY currency
          HAVING COALESCE(SUM(balance_minor) FILTER (WHERE normal_side = 'DEBIT'), 0) <> COALESCE(SUM(balance_minor) FILTER (WHERE normal_side = 'CREDIT'), 0)`.execute(db)
      ).rows,
    );

    // 5. Held money is exactly the sum of ACTIVE holds (docs §J.6)
    push(
      'HELD_BALANCE_EQUALS_ACTIVE_HOLDS',
      (
        await sql<{ customer_id: string; held_balance: string; active_holds: string }>`
          SELECT w.customer_id, a.balance_minor::text AS held_balance,
                 COALESCE(SUM(h.amount_minor) FILTER (WHERE h.status = 'ACTIVE'), 0)::text AS active_holds
            FROM ledger.wallet_accounts w
            JOIN ledger.accounts a ON a.id = w.held_account_id
            LEFT JOIN ledger.holds h ON h.customer_id = w.customer_id
           GROUP BY w.customer_id, a.balance_minor
          HAVING a.balance_minor <> COALESCE(SUM(h.amount_minor) FILTER (WHERE h.status = 'ACTIVE'), 0)`.execute(db)
      ).rows,
    );

    // 6. Every closed hold points at a transaction of the matching kind
    push(
      'CLOSED_HOLD_HAS_MATCHING_TXN',
      (
        await sql<{ hold_id: string; status: string; txn_type: string | null }>`
          SELECT h.id AS hold_id, h.status, t.txn_type
            FROM ledger.holds h LEFT JOIN ledger.transactions t ON t.id = h.close_txn_id
           WHERE h.status <> 'ACTIVE'
             AND (t.id IS NULL OR (h.status = 'RELEASED' AND t.txn_type <> 'HOLD_RELEASE') OR (h.status = 'SETTLED' AND t.txn_type <> 'HOLD_SETTLE'))`.execute(db)
      ).rows,
    );

    return { ok: violations.length === 0, checkedAt: new Date().toISOString(), violations };
  }
}
