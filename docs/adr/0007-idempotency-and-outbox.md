# ADR-0007: Idempotency keys claimed inside the business transaction; claim-based outbox with a delivery ledger

- **Status:** Accepted (requirements §26–§28; proposal §L)
- **Date:** 2026-10-06

## Idempotency
`@Idempotent()` (shared-kernel interceptor) wraps the whole request in **one database transaction** and claims `(principal, route, Idempotency-Key)` by inserting into `platform.idempotency_records` *inside that transaction*.

- A concurrent duplicate blocks on the unique index until the first transaction finishes, then replays the stored response (`Idempotent-Replayed: true`) or — if the first rolled back — runs itself.
- "Effect committed but response not recorded" is impossible: both commit together. Verified: 6 simultaneous identical requests → 1 execution, 5 replays; side effects (role grant, audit row, outbox event) happen exactly once.
- Same key + different payload → `422 IDEMPOTENCY_KEY_REUSED`, nothing executed. Keys are scoped per user and per route.
- **Failures are not recorded**: a failed request rolls back including its claim, so a corrected retry with the same key succeeds. Idempotency therefore applies to *successful outcomes*; a client with a new intent uses a new key.
- The header is optional on today's provider/catalogue creation endpoints and will be `required: true` on booking, payment, refund and payout commands.

## Outbox
`OutboxService.publish()` writes in the caller's transaction (a rolled-back business action never announces anything). The worker's `OutboxDispatcher`:
- **claims** batches with `FOR UPDATE SKIP LOCKED` and a visibility timeout (a crashed worker's claim expires and is re-taken), so any number of workers is safe — verified with four concurrent dispatchers over 40 events: each handled exactly once;
- runs each (event, consumer) in its own transaction together with its `outbox_deliveries` row, so a retry re-runs **only** the consumers that did not finish; consumers with external side effects get at-least-once and must dedupe on `event.id`;
- backs off exponentially with jitter and parks events as `FAILED` after N attempts (dead letter — never auto-deleted);
- completes events nobody consumes (a consumer added later does not receive history).

## Time source
Both mechanisms stamp times from the injected `Clock`, never the database default, so "is it due/expired?" is always compared on one clock (a mismatch was found and fixed during testing — see STATUS.md).

## Deviation from the proposal
`pg-boss` is **not** used yet: delayed jobs (booking expiry, reminders) can be modelled as outbox events with a future `available_at`, which the dispatcher already honours. Revisit if scheduling needs outgrow that.
