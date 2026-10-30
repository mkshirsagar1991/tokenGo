# ADR-0012: Razorpay as the payment provider — TEST MODE ONLY

- **Status:** Accepted for **test mode**. Razorpay is the chosen gateway for now (the product owner's decision, 2026-10-06, answering part of open question Q3). **This does not approve live money**: `rzp_live_` keys are refused by configuration, `PAYMENT_PROVIDER=razorpay` is refused in production, and `REAL_MONEY_ENABLED=true` is refused everywhere. Lifting those gates needs the legal/PSP review in proposal §K.4 (below).
- **Date:** 2026-10-06
- **Builds on:** ADR-0011 (provider abstraction, webhook trust model, settlement, refunds, reconciliation). Nothing in that pipeline changed for Razorpay — it is a new `PaymentProvider` implementation, which is what the abstraction was for.

## What was built
`RazorpayPaymentProvider` (`modules/payments/infrastructure/razorpay.provider.ts`) plus pure translation code (`domain/razorpay.ts`), written against Razorpay's published API reference:

| Need | Razorpay call |
|---|---|
| Create the payment request | `POST /v1/orders` (amount in **paise**, `receipt` = our intent id) |
| "Was it paid?" (server-side truth) | `GET /v1/payments/:id`, `GET /v1/orders/:id/payments` |
| Refund to source | `POST /v1/payments/:id/refund` with header **`X-Refund-Idempotency: <our refund id>`** |
| Refund state | `GET /v1/refunds/:id` |
| Reconciliation | `GET /v1/payments?from&to&count=100&skip` (paged; refuses to silently truncate a huge window) |
| Webhooks | `X-Razorpay-Signature` = HMAC-SHA256 of the **raw body** with the webhook secret; `x-razorpay-event-id` for dedupe |

## Decisions
1. **Only `captured` is money.** Razorpay does **not** capture automatically by default (it is a dashboard setting). `authorized` and `created` map to `PENDING` and are never credited; an unrecognised status also fails closed to `PENDING`. A payment that Razorpay marks `refunded` was captured and is treated as such (its refunded amount is tracked separately). The abstraction gained `PENDING` and `amountRefundedMinor` for this.
2. **Webhooks carry no timestamp**, so Razorpay's scheme gives no replay window. That is safe here only because events are deduplicated on the event id *and* the payment is re-fetched from Razorpay before anything is credited — a replayed or forged "captured" event cannot credit anything the provider does not say is captured. `payment.authorized`, `order.paid` and `payment.captured` are all routed as "go and look"; the fetch decides.
3. **Error classification decides whether a customer's money moves.** Network errors, timeouts, 5xx, 429, **409** (an identical refund request in flight) and **401/403** are *transient*: retried, nothing assumed. Only a 400/404 carrying Razorpay's `error` object is a *definitive refusal*; a bare 404 (their API gateway) is not. A bad API key must never be read as "Razorpay refused the refund" — that would hand the customer their money back while the refund might still go out. (Mutation-tested.)
4. **Refund idempotency** uses Razorpay's own header (≥10 chars, `[A-Za-z0-9_-]`; our UUIDs qualify; a changed body under the same key is rejected by Razorpay). A response that never arrived is retried with the same key and returns the *same* refund — the Razorpay-specific form of query-before-retry. Our refund id is also sent in `notes.reference` so a webhook or poll can be correlated back to it.
5. **Credentials only go to Razorpay.** The base URL may be `https://api.razorpay.com/…` or a `localhost` test double, nothing else (lookalikes such as `api.razorpay.com.evil.example` and `…@evil.example` are rejected). The key secret and webhook secret never appear in responses, logs or stored errors (asserted).
6. **Reconciliation can now see refunds made outside our system** (e.g. someone presses *Refund* in the Razorpay dashboard): `REFUND_MISMATCH` when Razorpay shows more refunded than we ever requested. The other direction is timing, not an alarm.

## How it was verified — and how far that goes
- 40 unit tests of the mapping/signature code using the exact example payloads from Razorpay's reference; 23 integration tests driving the real application against a **local test double** (`test/support/fake-razorpay.ts`) with fault injection (dropped response after the refund was created, 409, 500, 401); 12 config tests.
- Two safety rules were mutation-tested (treating `authorized` as captured; treating 401 as a refusal): the suite fails for each.
- **Contract check against the REAL Razorpay test API (2026-10-07, `pnpm --filter @tokengo/api razorpay:check`, 14 checks, no money, one never-paid test order).** Confirmed: Basic auth; order creation in paise with our receipt; `listOrderPayments` of an unpaid order is empty; `GET /payments` accepts `count=100` and rejects 101; a wrong secret answers 401; a valid-format unknown payment id answers **400 "The id provided does not exist"** (my flagged assumption was right). It also **corrected three things I had guessed from the docs**, now fixed in the adapter, the test double and the tests:
  1. An unknown (valid-format) refund id is **400 "invalid request sent"**, not 404; the payments of an unknown order are **200 with an empty list**, not an error.
  2. A bare **404 `{"message":"no Route matched with those values"}`** is Razorpay's API *gateway* (it is what a malformed id gets), not the application refusing. The first version treated every 400/404 as a definitive refusal, which would have aborted a refund and handed the customer's money back over a routing answer. It is now **definitive only when Razorpay's application returns an `error` object**; a gateway 404 is retried.
  3. A **status lookup can never abort a refund** (found while fixing 2): only a definitive refusal of the *create* call may return the customer's money.
  Razorpay also accepted a receipt longer than the documented 40 characters; our stricter guard is left in place.
- **Not yet verified against Razorpay:** a real payment through Checkout (and therefore capture behaviour, `authorized` vs `captured` for your account's settings), a real refund, the `X-Refund-Idempotency` replay, and real webhook delivery (needs a public URL). A harness exists for all but webhook delivery (`rzp-live-e2e`, needs a person to complete the test checkout); until it has passed, treat payment and refund handling as verified only against the double.

## To try it against a real Razorpay test account
Set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (see `apps/api/.env.example`). In the Razorpay dashboard (Test Mode): enable auto-capture; add a webhook to `POST <public URL>/api/v1/payments/webhooks/razorpay` with the same secret for `payment.authorized, payment.captured, payment.failed, order.paid, refund.created, refund.processed, refund.failed` (a tunnel such as ngrok is needed for a local machine). The app opens Razorpay Checkout with `checkout.key_id` + `checkout.order_id` from `POST /api/v1/payments/intents`, then calls `POST /api/v1/payments/intents/:id/verify`.

## What choosing Razorpay does NOT settle (proposal §K.4 — still open)
- **The wallet model.** A customer-funded, multi-provider wallet is, as I understand it (unverified, needs counsel), likely a prepaid payment instrument in India that needs RBI authorisation or a licensed partner; an internal ledger is not escrow. Picking a gateway does not change that. Razorpay's marketplace/split-settlement product (Route) is a different arrangement with its own agreement and linked-account KYC, and would change the payment model (proposal option C) — it is **not** built.
- **Payouts.** RazorpayX is a separate product (separate account, KYC and agreement). Payouts are built behind their own abstraction with a sandbox only (ADR-0013); a RazorpayX adapter is not built.
- **Refund-to-source rules, settlement timing, fees, GST/TCS** — all provider- and counsel-dependent.
