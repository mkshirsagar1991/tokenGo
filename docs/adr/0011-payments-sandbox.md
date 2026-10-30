# ADR-0011: Payments — a provider abstraction, a sandbox simulator, and a webhook trust model

- **Status:** Accepted for the SANDBOX only (requirements §14, §29 test 4; proposal §K). **No real money moves.** Choosing and integrating a live PSP is blocked on the payment-model and legal review (open questions Q1–Q7); `REAL_MONEY_ENABLED=true` is still refused at startup.
- **Date:** 2026-10-06

## Context
A wallet top-up is the one place real money enters the system, so it is where the worst bugs live: a callback delivered twice, late, out of order, forged, or never; an amount that is not what was asked; a refund that is sent twice or lost. The ledger (ADR-0009) already makes every posting idempotent and balanced; this ADR decides how a *payment provider's* claims become ledger entries.

## Decisions

### 1. One abstraction, two implementations, nothing live
`PaymentProvider` (`domain/payment-provider.ts`) is the only thing the module talks to: create an order, fetch a payment, list payments (for reconciliation), create/fetch a refund, verify a webhook. Implementations: `SandboxPaymentProvider` (an in-database simulator) and `DisabledPaymentProvider` (every call → 503 `PAYMENTS_DISABLED`). A real PSP is a third implementation plus a review — not a rewrite.
`PAYMENT_PROVIDER` defaults to `sandbox` outside production and `disabled` in production; an **explicit** `sandbox` in production is refused at startup (config test). The sandbox routes answer 404 whenever the sandbox is not the live provider.

The sandbox behaves like a real PSP where correctness depends on it (server-side fetch, one capture per order, idempotent refunds keyed by a client key, HMAC-signed webhooks) and talks to the database through **its own small connection pool**, never the request's transaction: a real provider's state does not roll back with ours, and calling it must not compete with the application for connections (an earlier draft borrowed the application pool; with the idempotency interceptor holding one connection per request that could deadlock under load).

### 2. The wallet is credited only from a provider-FETCHED payment (never from a webhook body or the client)
There is **one** code path that credits a top-up — `PaymentSettlementService.applyPayment(providerPayment)` — fed by three interchangeable triggers: a webhook, a scheduled recovery check, and the customer's "verify" call. Every trigger obtains the payment by a server-to-server `fetchPayment`; the webhook body is only a hint ("go and look at payment X") and its amount/status are ignored. A "captured" event for a payment that actually failed credits nothing; an inflated amount in the body is ignored.

### 3. Why duplicate / delayed / out-of-order delivery cannot double-credit (critical test #4)
Four independent layers, each sufficient on its own for its case:
1. the payment-intent row is `FOR UPDATE`-locked, so concurrent deliveries run one at a time;
2. `payment_transactions (provider, provider_payment_id)` is unique — a payment is recorded once;
3. the ledger posting carries the idempotency key `topup:<provider>:<payment id>`;
4. we act on the provider's *current* state, so event order is irrelevant, and a "failed" report can never undo a recorded capture.
Webhook intake adds a fifth for efficiency and audit: unique `(provider, provider_event_id)`. A mutation test (removing layers 2–3 in code) is caught by the suite; the event-id layer alone still protects pure redelivery, which is why it is not the only one.

### 4. Webhook intake rules
Authenticate over the **raw bytes** (`rawBody` is enabled at bootstrap) with HMAC-SHA256 over `"<t>." + body`, constant-time compare, ±5 min tolerance, multiple `v1` values for secret rotation. Persist before acting. A forged request is stored **without any attacker-supplied field** (no event id, no payload — enforced by a CHECK constraint), so it can never occupy the dedupe key of the real event. Answers: 2xx = stop sending (processed / duplicate / ignored), 401 = not authentic, 404 = unknown provider, 503 = our fault, redeliver (the row is kept `FAILED` and retried, never lost). An event stuck in `RECEIVED` for 30 s is treated as a crashed attempt and processed again.

### 5. Anything that does not match is quarantined, not guessed
Provider captured a different amount/currency than the intent → the payment is recorded `QUARANTINED`, **not credited**, audited, and an event is emitted. A late capture on an `EXPIRED` intent **is** credited (the money was taken; the books follow reality) and flagged `payment.late_capture_credited`; a second capture on an already-paid intent is credited and flagged `payment.duplicate_capture_credited`. A DB `CHECK` makes "CAPTURED without a ledger transaction" impossible.

### 6. Lost callbacks are recovered, with two independent mechanisms
(a) Each intent schedules an outbox `payments.intent_check` (2 min, then backing off to 10 min), each check scheduling the next until the intent settles or expires at its deadline. (b) A periodic sweeper in the worker re-checks stale `PENDING` intents and `PROCESSING` refunds. Both run the same idempotent code, so neither can conflict with a webhook.

### 7. Refunds to the original instrument — three ledger steps, provider called after commit
`request`: `DR customer_available / CR refund_clearing` (the money leaves the wallet at once and cannot be spent while the refund is in flight; fails cleanly with `REFUND_FUNDS_ALREADY_SPENT` if it is already gone). `success`: `DR refund_clearing / CR gateway_clearing`. `failure`: a **compensating reversal** of the request (history is never edited). The provider is called by an outbox consumer **after** the request commits, with our refund id as the provider-side idempotency key; a refund whose provider id is already known is *queried*, not re-created (query-before-retry — the same pattern payouts will use for critical test #7). A definitive provider refusal fails the refund and returns the money; a network error retries with backoff and the sweeper is the backstop. Refundable amount is computed under a row lock on the payment, so concurrent refunds cannot exceed it.

### 8. Reconciliation reports; it never repairs
`POST /admin/payments/reconciliation` compares our captured payments with the provider's for a period (≤ 31 days), keyed on the provider's payment id **and the provider's own timestamp** (so a payment on a window edge cannot appear on one side only). Exceptions are `MISSING_INTERNAL` (the provider took money we have no record of), `MISSING_EXTERNAL`, `AMOUNT_MISMATCH` (including quarantined payments). Only exceptions are stored; matches are a count.

### 9. Authorization and data minimisation
Customers: own intents only (404 for others). `refund:create` / `payments:reconcile` → FINANCE_OPERATOR only; `payments:read` → finance, support, admin; all privileged roles need an MFA-verified session. Admin views and audit rows carry ids, amounts and states — never payloads, card data or contact details.

## Consequences / known gaps
- The customer's statement shows the refund *reservation* line only ("Refund to your original payment method"); the completing posting touches platform accounts, so the statement does not show "sent" vs "processing" (a read-model join to `payments.refunds` is a follow-up).
- Quarantined payments have no resolution workflow yet (refund-at-provider / adjust); they are surfaced via `GET /admin/payments/transactions?status=QUARANTINED` and reconciliation.
- Webhook endpoint has no IP/rate throttling beyond the app-level limits; forged rows are trimmed after 14 days by the sweeper.
- No chargeback/dispute events, no payouts (critical test #7's payout leg), no real PSP, no 3-D Secure/UPI specifics — all depend on the PSP choice.
