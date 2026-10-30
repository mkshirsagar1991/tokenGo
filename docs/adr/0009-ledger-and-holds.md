# ADR-0009: Immutable double-entry ledger with a hold/settle model

- **Status:** Accepted (requirements §11, §12; proposal §J). **No real money moves** — see "Scope".
- **Date:** 2026-10-06

## Decision
`wallet-ledger` is a **leaf module** (it depends only on the shared kernel). Money is recorded in `ledger.accounts` / `transactions` / `entries` as balanced debits and credits; a wallet is a *pair* of ledger accounts (`CUSTOMER_AVAILABLE`, `CUSTOMER_HELD`), and a booking reserves money through a `ledger.holds` row — never `balance = balance - x`.

Only **named operations** exist on `LedgerService` (credit verified payment / dev test funds, `createHold`, `releaseHold`, `settleHold`, `reverseTransaction`); there is no "post arbitrary entries" and no API that sets a balance.

### Protections that do not depend on application code
- `entries`/`transactions`: UPDATE/DELETE/TRUNCATE rejected by trigger.
- A **deferred constraint trigger** requires every transaction to balance (Σ debits = Σ credits, ≥ 2 entries) at COMMIT.
- `CHECK (balance_minor >= 0)` on customer, provider-payable and clearing accounts — an overdraft cannot be committed even by buggy code.
- A closed hold is frozen (trigger): no reopening, re-closing, amount change or deletion; one ACTIVE hold per (booking, purpose) by partial unique index.
- A transaction can be reversed at most once (unique index); a reversal cannot be reversed.
- Per-account gapless sequence numbers and `balance_after` on every entry.

### Concurrency
`LedgerPoster` locks every involved account **in id order** (no lock-order deadlocks) and `createHold` locks the customer's available account before checking funds, so simultaneous bookings can never spend the same money. Closing a hold is a compare-and-set under a row lock, which makes "release twice", "settle twice" and "refund racing settlement" exactly-once by construction. Idempotent replays are detected **before** the funds check (a retry after success must return the original hold, not fail because the funds are already held).

### Reconciliation
`LedgerIntegrityService` re-derives every cached balance from entries and checks sequence continuity, per-transaction balance, the trial balance, and `held == Σ ACTIVE holds`; `GET /admin/ledger/integrity` (finance/admin, MFA) exposes it. It **reports, never repairs**: repairs are compensating transactions.

## Verification (25 integration tests, real PostgreSQL)
Includes: the requirements' ₹1000→₹800/₹200 example; ₹200 settled to ₹180 payable + ₹20 commission; 50 % cancellation split in one transaction; 12 concurrent ₹30 holds against ₹100 → exactly 3 succeed; release-vs-settle race ×6 → exactly one outcome; replay after funds consumed; DB-level tamper tests; a **randomised concurrent run** (mixed top-ups, holds, releases, settlements with refund splits) asserting integrity and **conservation of money** (with non-vacuity checks).

## Scope and honest limits
- This is the platform's **internal book of record**. It is **not** escrow, not a regulated wallet, and says nothing about where customer money is actually held (proposal §13/§K.4 — unresolved, needs legal/PSP input). `GATEWAY_CLEARING` is the placeholder for whatever the approved payment model provides. `REAL_MONEY_ENABLED=true` is refused at startup.
- `DEV_TEST_CREDIT` funds exist for development only and are refused in production.
- Not yet built: payments/PSP adapter (top-ups, refunds-to-source), provider payables rows + payouts, maker-checker for manual adjustments, scheduled integrity run in the worker.
