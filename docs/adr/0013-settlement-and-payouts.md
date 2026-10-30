# ADR-0013: Settlement & provider payouts — payables are not payments, and a timeout means "unknown"

- **Status:** Accepted for the **sandbox only** (requirements §19, §28; proposal §G/§K; critical test #7). No real money moves; there is no live payout provider. `PAYOUT_PROVIDER=sandbox` is refused in production (default there: `disabled`).
- **Date:** 2026-10-06

## Context
After a service is settled the platform owes the provider money. That is a *liability on the ledger*, not money in the provider's bank account (requirements §19). Getting it into the bank is a separate, failure-prone, external operation whose worst bugs are paying twice and paying the wrong account.

## Decisions

### 1. Three different things, three different records
- **Payable** (`settlement.provider_payables`): "we owe this provider ₹X for this settlement". One row per ledger posting that credited the provider's payable, `ACCRUED → IN_PAYOUT → PAID`.
- **Payout** (`settlement.payouts`): a bank transfer that has been asked for. `RESERVED → SUBMITTED → PAID | FAILED`.
- **Ledger** (`PROVIDER_PAYABLE`, `PAYOUT_CLEARING`, `GATEWAY_CLEARING`): the source of truth for the money. The settlement tables are a read model that is checked against it.

### 2. Payables are recorded from the ledger, not from booking events
`settleHold` now publishes `ledger.provider_payable_credited` for every provider it credits, so every way a provider can earn — completed service, late-cancellation fee, no-show fee — is covered by one mechanism (booking previously announced only the full-settlement case). Rows are unique per `(ledger posting, provider)`, so redelivery records nothing new. Verified through the real booking flows (₹180/₹20; 50 % fee ₹90/₹10; no-refund ₹180/₹20).

### 3. Money moves in three ledger steps; the provider is called after commit
`reserve` (`DR provider_payable / CR payout_clearing`) in the same transaction that picks the payables and creates the payout → provider call by an outbox consumer **after** that commits → `complete` (`DR payout_clearing / CR gateway_clearing`) or a **compensating reversal** on failure. While in flight the money is visibly *in transit*, neither owed nor paid. History is never edited.

### 4. Critical test #7 — a payout retried after a timeout is paid ONCE
Every payout carries OUR reference (the payout id). **Before creating anything the service asks the provider whether it already has that reference**; a timeout is an UNKNOWN outcome resolved by that lookup, never by sending again. Verified: the provider created the transfer but the response was lost → the retry found it and `createPayout` was not called a second time (mutation-tested: removing the lookup fails the test). Attempt counts and the last error are written on a separate connection so operators see them even though the consumer's transaction rolled back. A *definitive* refusal (e.g. beneficiary blocked) is the only thing treated as "it did not happen".

### 5. Concurrency: two workers can never pay the same money
`FOR UPDATE SKIP LOCKED` on the payable rows plus a per-provider advisory lock, so one payout is created per provider at a time and a payable can be in only one payout. The ledger's balance check is a backstop, not the mechanism — the test asserts the backstop never fires (mutation-tested: without the locks the test fails).

### 6. Who gets paid, when
Only an **APPROVED** provider with a **VERIFIED** bank account that has stood for the **cooling-off** period (account-takeover control; default 24 h), whose money is past the **payout delay** (default 24 h), whose total reaches the **minimum** (default ₹100), who is **not paused**, and who has **no payout already in flight**. Payouts are packed oldest-first under a per-payout cap (a single payable above the cap is paid alone rather than stranded). Providers are told *why* they are waiting (`NO_VERIFIED_ACCOUNT`, `BELOW_MINIMUM`, `ACCOUNT_COOLING_OFF`, `PAUSED`, …).

### 7. Failure handling
Refused/failed/reversed-before-paid → reservation compensated, payables back to `ACCRUED` with an escalating delay (1 h, 2 h, 4 h … ≤ 24 h) and retried in a **new** payout with a new reference. Three consecutive failures **pause the provider automatically** for human review. **Contradictions are never auto-corrected**: "paid" for a payout we already failed, "reversed" after we booked it paid, or a different amount flags the payout `needs_review`, pauses the provider and moves no money.

### 8. Bank details
Account number and holder name are encrypted (AES-GCM field cipher); only the last four digits and the IFSC stay readable; a keyed hash allows finding shared accounts. Audit rows and outbox events carry ids and last-four only (asserted). A bank check must pass, **including the registered name matching** the typed name (so a stranger's account is not paid; found and fixed a real defect here: `D'Souza` must match `DSOUZA`). Replacing the account is atomic, keeps history, restarts verification, and is rate-limited (5/day).

### 9. Integrity and reconciliation
`GET /admin/payouts/integrity` checks that payable rows equal each provider's ledger payable balance, that `PAYOUT_CLEARING` equals the open payouts, that each payout equals its payables, and that payable/payout states agree. Payout reconciliation compares our payouts with the provider's for a period (`MISSING_INTERNAL` — a transfer we did not make — `MISSING_EXTERNAL`, `AMOUNT_MISMATCH`, `STATUS_MISMATCH`); it reports, it never repairs.

## Verified (real PostgreSQL)
50 unit tests of the pure rules; 51 integration tests; plus a run of the **compiled** API and a **separate worker process** end to end (23 checks: ledger settlement → worker records payables → bank account verified by the worker → finance run → worker submits → provider pays → refresh completes → integrity OK, `PAYOUT_CLEARING` back to zero).

## Known gaps
- **No real payout provider.** RazorpayX (or another) needs its own account/agreement and an adapter; the sandbox only models the behaviours listed above (including its deterministic fault conventions).
- **No payout webhooks:** completion is learned by polling (every 2 min for open payouts) and by operator refresh; a transfer returned by the bank *after* being paid is only noticed by reconciliation.
- **Clawbacks** (refund after payout), **maker-checker** on freezing/unfreezing and bank-account overrides, **tax** (TDS/GST), provider-facing payout notifications (the events are published; nothing consumes them), and **payout limits per day** are not built.
- The cooling-off and change rate-limit reduce, but do not eliminate, account-takeover risk; stronger step-up authentication for bank changes is still needed.
