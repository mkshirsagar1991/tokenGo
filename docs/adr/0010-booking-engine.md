# ADR-0010: Booking engine — one transaction, explicit state machine, event-driven time

- **Status:** Accepted (requirements §15–§18, §28; proposal §I, §L)
- **Date:** 2026-10-06

## Creating a booking is ONE database transaction
`POST /appointments` (with a **required** `Idempotency-Key`) runs, inside the idempotency transaction:
re-validate the slot with the same engine the public list uses → resolve price, commission rule and cancellation policy from trusted records → **hold the funds** (locks the wallet) → **reserve the slot** (exclusion constraint) → insert booking, item snapshot, financial snapshot, verification row, first event, audit, outbox events. If *any* step fails — insufficient funds, slot lost, a later insert — everything rolls back: no hold, no reservation, no booking. Tests inject failures after the hold and after the reservation to prove this.
The request body carries **no** amount, price, commission or status; unknown fields are rejected.

"Any stylist" tries candidates least-loaded-first using `INSERT … ON CONFLICT DO NOTHING` (verified on PostgreSQL: it also covers exclusion-constraint conflicts and, unlike a raised error, keeps the transaction usable).

## State machine
`domain/booking-state.ts` lists every legal (state, command, actor) — 13 tuples; the unit test enumerates all `15 states × 10 commands × 4 actors` and asserts everything else is refused. Status is only changed by named command endpoints (no generic update; `PATCH /appointments/:id` is a 404). Funds, settlement and payout are **separate dimensions** (`funds_status`, `settlement_status`). Every transition is a compare-and-set under a row lock, appends an immutable `booking_events` row, an audit row and an outbox event.
Deviations from the proposal (recorded as decisions G1–G3): `NO_SHOW` added; `PROVIDER_APPROVED` collapsed into `CONFIRMED`; `DRAFT/PAYMENT_PENDING/PAYMENT_HELD` exist in the enum but are unused by the wallet model.

## Money rules
- **Snapshots:** the price, the commission rule (id, version, bps/fixed) and the cancellation policy in force at request time are frozen into the booking. A test changes the platform commission (10 → 20 %) and the provider's price *after* a request and shows the original booking still settles at ₹200 / 10 %, while a new booking uses the new values.
- **Cancellation:** pending request → full refund; confirmed → refund by the snapshotted tiers (≥24 h 100 %, ≥2 h 50 %, else 0 %); provider cancellation → 100 %; no-show → configured % after a grace period. A partial refund is **one** ledger settlement: refund to the customer, the retained fee split provider/platform by the snapshotted rule. Refund + retained always equals the held amount exactly.
- **Settlement:** completion is an explicit staff action (never inferred from the clock — a test proves a booking whose end passed a week ago stays `CONFIRMED`/`HELD`). After completion the customer may confirm (immediate) or the dispute window (default 24 h, configurable) elapses; either path settles **exactly once**.

## Time-driven work
The response deadline and the settlement window are **outbox events with a future `available_at`** — they fire whether or not any app is open, with exactly-once effects via the delivery ledger. "Not due yet" throws so the dispatcher retries instead of dropping the event. A **sweeper** (`BookingService.sweepOverdue`) is a safety net for work whose event was lost or dead-lettered.

## Arrival verification
PIN = HMAC(server secret, booking id) → 6 digits (stable, nothing stored); QR = `v1.<bookingId>.<expiry>.<hmac>` valid 5 minutes; neither contains personal data. Verification is only possible inside the check-in window; 5 wrong attempts lock the booking's verification for 15 minutes (the failed-attempt count is committed even though the request fails); a manager can override by hand with a reason (audited, higher permission).

## Authorization
Customers act only on their own bookings; provider users need `appointment:*` permissions scoped to the booking's provider **and location**; outsiders get 404 (existence not disclosed), related users lacking the permission get 403; support/finance read via `appointment:read_any` (MFA session only).

## Known gaps
Additional charges (§9/G6), disputes (`DISPUTED` has no entry command yet), notifications consumers, provider payable rows/payouts, ratings, and the SLA reporting views.
