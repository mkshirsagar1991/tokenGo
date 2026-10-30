# ADR-0014 — Mobile apps: shape, trust boundary, and what the app is never allowed to decide

**Status:** accepted · **Date:** 2026-10-07

## Context
Requirements §5/§6/§33 call for a customer app and a provider app (Flutter, Android first). Both talk to the same API, share a
sign-in flow, a theme, money formatting and an HTTP client with token refresh, and differ in everything else.

## Decision

**One Dart pub workspace, three packages** (`apps/mobile`):

| Package | Holds |
|---|---|
| `packages/tokengo_core` | API client (single place that does HTTP), session + token refresh, typed models, repositories, the design system, the shared sign-in screens, shared Riverpod providers (`sessionManagerProvider`, `apiBaseUrlProvider`, `apiClientProvider`, `authRepositoryProvider`). No navigation: screens take callbacks. |
| `customer` | Discovery (list + map), provider profile, booking flow, bookings, wallet + Razorpay top-up, profile. |
| `provider` | Today (review status + setup checklist, then requests, schedule, earnings), bookings, earnings/payouts/bank account, **Business** (registration, locations, services, staff and invitations, hours, time off, walk-in blocks, booking rules), account. |

State: Riverpod 3. Navigation: go_router 18 with a `StatefulShellRoute` (tabs) and full-screen routes **nested under their tab**, so Back
always has somewhere sensible to go. Tokens live in the platform keystore (`flutter_secure_storage`), never in plain preferences.

**The app never decides anything the server owns.** This is the rule every screen is written against:
- **Money** is integer minor units end to end (`Money`); the app sends no prices, totals, commission, statuses or balances. A booking
  request carries a location, service, start time and optional stylist; the server prices, holds funds and reserves the slot in one
  transaction.
- **Idempotency.** Booking creation and top-ups send an `Idempotency-Key` generated **once per attempt** and re-sent on retry, so a
  dropped connection never creates a second booking or payment request. The key is renewed only when the user's choices change.
- **Payments.** The app asks the server to create a payment request, opens Razorpay Checkout for the **server-created order**, then
  asks the **server** to verify with Razorpay. "Checkout said success" is a hint, never a credit. If confirmation is slow the UI says
  "not confirmed yet" (not "failed", not "added"); a lost connection after paying is reported the same honest way, and the sheet
  cannot be dismissed while money may be moving. (`top_up_sheet_test.dart` pins each of these.)
- **State changes** (accept, decline, verify arrival, start, complete, cancel) are requests; the screen re-reads the booking from the
  server after **every** attempt, success or refusal, and shows the server's own reason when it refuses.
- **Time.** Times shown for a booking are the **location's** wall-clock (the server sends `local_start`); the phone's time zone is
  never applied to them.
- **Location** permission is requested only when the person taps "use my location"; discovery works with a chosen city.

**Build configuration is `--dart-define`d** (`API_BASE_URL`, `MAP_TILE_URL`); the debug manifest alone allows cleartext HTTP to the
host machine (`10.0.2.2`). Release builds inherit https-only. The map is a tile-URL template, so switching provider is configuration.

## Consequences / defects found on the way (and the guard for each)
- **Sign-in did not leave the code screen.** The server accepted the code and the session was stored, but the app stayed on the code
  screen. Root cause: go_router re-runs `redirect` against the page-based location, **not** for screens opened with `push`, so the
  "leave `/login*` once signed in" redirect never fired for pushed sign-in screens. Fix: the code screen takes an explicit
  `onSignedIn` callback. Guard: `sign_in_flow_test.dart` (customer) and `sign_in_test.dart` (provider) — verified to fail with the
  call removed.
- **Back from a new booking landed on a blank booking form.** `pushReplacement` left the booking flow in the stack. Fix: booking
  detail is nested under the Bookings tab and a new booking navigates there with `go`.
- **First Gradle build impossible on this machine** (three independent causes, recorded in the dev-environment notes): the user's
  `%TEMP%` rejects Unix-domain sockets, which JDK 17's NIO selector uses on Windows (`Unable to establish loopback connection`);
  Flutter provisions an NDK for *every* Android module and plugin modules defaulted to a 1.5 GB NDK 28 (pinned to the installed
  NDK 27 in `android/build.gradle.kts`); Kotlin incremental caches cannot span drives when the project is on `E:` and the pub cache
  on `C:` (`kotlin.incremental=false`).

## Provider onboarding rules (added with the Business area)
- **Creating things carries an `Idempotency-Key`** (`AttemptKey`): one key per attempt, re-sent on a retry, renewed when the form's body changes.
- **Money in forms** is typed in rupees and converted by digit manipulation (`MoneyInput`), never `double * 100`.
- **Times of a location** (hours, breaks, time off) are its wall-clock strings; the one place the API takes instants (walk-in blocks) is built
  with the *location's* IANA zone (`instantAt`), never the phone's.
- **Booking rules**: the server REPLACES a business's overrides with what a PUT carries, so every field is sent as displayed.
- **Permissions on demand**: camera (QR) and location (map pin) are requested only when the owner taps the control that needs them.
- Riverpod 3 pauses listeners of routes that are not on top, so a list under a form re-reads (it was invalidated) when the form is left.

## Not decided here / known gaps
Push notifications (the provider app polls every 30 s), iOS builds, release signing and
store listings, offline caching, localisation, an accessibility audit, and a real map tile provider for production (OSM's usage policy
forbids heavy production use). Razorpay Checkout has been opened against the real **test** API but a full test payment through the
app has not been completed by a person.
