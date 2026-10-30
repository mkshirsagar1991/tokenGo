# ADR-0008: One reservation table guarded by an exclusion constraint; a pure slot engine; instants-based time alignment

- **Status:** Accepted (requirements §10; proposal §H, §L). **Deviates from proposal §G.4** (see below).
- **Date:** 2026-10-06

## Decision
1. **`scheduling.resource_reservations` is the only place that says "this resource is occupied during this range".** It holds provider-created BLOCKs now and customer BOOKINGs from the booking phase. `EXCLUDE USING gist (resource_id WITH =, occupied WITH &&) WHERE status = 'ACTIVE'` makes double-booking impossible for *every* kind of reservation, whatever the application does. A violation (SQLSTATE `23P01`) is mapped to `409 SLOT_UNAVAILABLE`.
   *Deviation:* the proposal put `appointments` (with the constraint) in the booking module. Splitting "blocks" and "bookings" across tables would need two constraints that cannot see each other, so the constraint lives with the availability module and the booking module will reference reservation ids through `AvailabilityFacade`.
2. **The slot engine is a pure function** (`computeSlots`): no I/O, no clock, no randomness. Everything is passed in, so it is exhaustively testable. Its output is *advisory* (responses carry `meta.advisory: true`); the commit path re-validates against the constraint.
3. **Times are stored in UTC; recurring hours are local wall-clock minutes** interpreted in the location's IANA timezone at query time.
4. **Alignment is defined on instants**: a slot start is an instant whose *local* minute-of-day is a multiple of the granularity. This (rather than converting wall-clock times back to UTC) is what makes DST right: a wall time that does not exist is never produced; one that happens twice is produced twice; a DST shift that is not a multiple of the granularity (Lord Howe) re-aligns instead of drifting.
5. Policy (granularity, lead time, advance window, response deadline) is data: a seeded platform row, overridable per provider, resolved field-by-field. A resource with no skill rows is a generalist; a resource with no schedule follows the location's hours.

## Verification
- Unit tests incl. spring-forward (23 slots), fall-back (25), Lord Howe.
- A **property test against an independent minute-by-minute oracle**: engine output must equal the oracle's exactly (sound *and* complete) across random schedules, four zones and real DST dates — verified at 300 cases (default 60 in CI; `PROPERTY_RUNS` to raise). A non-vacuity guard fails the test if too few generated cases contain slots (it caught an over-sparse generator).
- DB constraint tests: 8 simultaneous identical block requests → exactly 1 wins; mixed partially-overlapping concurrent requests leave no overlap; raw SQL cannot bypass the constraint.

## Known limits
- Search computes availability for a bounded candidate set (≤100) when a filter/sort needs it; very dense areas could under-return for availability filters. Precomputed slot tables were rejected (stale data, two sources of truth).
- Availability enrichment issues a few queries per candidate; bulk loading is the first optimisation if load tests demand it.
