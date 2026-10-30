# TokenGo — implementation status

**As of:** 2026-10-07 · **Scope delivered:** the backend (`apps/api`) through discovery, availability, booking, ledger and settlement; **payments with a sandbox simulator and Razorpay (TEST MODE ONLY)**; **provider settlement & payouts (sandbox payout provider only)**; and, new this round, **the Flutter customer app and provider app, running on an Android emulator against the real API** (ADR-0014). Also present since (see the update below): the **admin web portal**, notification / support-and-disputes / reviews / provider-document API modules, and an API Dockerfile. **Not started:** Terraform and AWS, any LIVE payment or payout provider, additional charges, and admin screens for disputes and documents.

> This report states only what has been **run and observed**. Where something was written but not executed, or cannot be verified here, it says so.

> **Update — 2026-10-07 evening (after a session hand-over).** The header above and §2 predate several pieces that an earlier session built and this one re-measured and exercised, so "Not started" in the header is **out of date**. In the tree now: API modules `notifications` (FCM push provider, templates, outbox consumers, admin delivery list), `support` (disputes, evidence attachments, staff decisions with an operator limit), `reviews`, provider documents and account deletion (migrations 13–18); the **Next.js admin portal** `apps/admin` (§2b); `apps/api/Dockerfile`; more provider-app screens (QR scan, locations, services, onboarding). **Exercised this session:** the admin portal end to end against the compiled API + a separate worker + real PostgreSQL + the **real Razorpay TEST API** (§2b); the production Docker image (§2c). **Not exercised by me:** the new API modules beyond their own test suites (notifications, support/disputes, reviews, documents) and FCM against the real service. Their per-module rows and ADRs are not written yet.

## 1. Verified results

| Gate | Result |
|---|---|
| `eslint` over `src` **and `test`** (incl. a ban on `parseFloat`) | ✅ clean |
| `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) | ✅ clean |
| `dependency-cruiser` module boundaries | ✅ 0 violations (173 modules) |
| `nest build` | ✅ (reproducible from a clean `dist/`) |
| **Backend tests: 37 suites / 711 tests** | ✅ all pass on **real PostgreSQL 16 + PostGIS 3.4** (Docker), re-run 2026-10-07 after the fixes in §3 (D20, D21). Includes the new `declared-dependencies.unit.spec.ts` (every runtime `require` of the compiled code must be a declared dependency; mutation-checked) |
| **Flutter tests: 173** (core 114, customer 15, provider 44; re-run 2026-10-07) + `flutter analyze` clean in all three packages | ✅ widget/unit tests over a fake API (top-up money rules, sign-in navigation, booking actions) **plus 15 contract tests that run every parser over responses captured from the real dev API**. The sign-in and contract tests were each **checked to fail with their fix removed** |
| **Admin portal (`apps/admin`)** | ✅ `tsc` + `eslint` clean, **201 vitest tests** pass, **`next build` succeeds** (35 routes); driven in a browser and by a black-box security script — see §2b |
| **Android debug APKs (customer, provider)** | ✅ built; installed and driven on an emulator (Pixel 6, API 33) against the real API — see §2a |
| `pnpm audit --prod` | ✅ no known vulnerabilities |
| Production migrate path on a fresh DB | ✅ 18 migrations — also applied **inside the `migrate` container image** to a fresh database (§2c), and 14 → 18 on a populated dev database |
| Compiled build, payments over real HTTP (previous round) | ✅ 17 checks incl. real signed raw-body webhooks, 8 simultaneous redeliveries → credited once, the **worker process** settling a lost callback |
| **Compiled build, settlement & payouts (this round)** | ✅ 23 checks against the built API + a **separate worker process**: ledger settlement → worker records payables → worker verifies the bank account → finance run creates ONE payout → worker submits it → bank "pays" → refresh completes it (and a second refresh is a no-op) → provider sees paid, nothing owed → settlement integrity OK → every ledger transaction sums to zero → `PAYOUT_CLEARING` back to zero |
| `seed:dev` (earlier work) | ✅ verified in the previous round; **not re-run this round** |

**Backend test breakdown (measured earlier from Jest's JSON report; the 3 new tests are in the Razorpay suite):** unit — money 9 / ids 4 / crypto 6 / logger 2 / **config 24**, TOTP 9, slot engine 23 + property tests vs an independent oracle 4, pricing rules 8, booking state machine 10, webhook signature 8, **Razorpay mapping/signature 40**, **payout rules 50**; integration — auth 23, admin MFA 13, provider/catalog/RBAC 29, outbox + idempotency 18, availability 40, PostGIS search 19, ledger 25, booking 41 (now also asserting the payables each booking path produces), payments top-up/webhooks/recovery 47, payments refunds/reconciliation/authorization 32, **payments via Razorpay 23**, worker wiring 2, **settlement & payouts 51**.

### The ten critical financial tests (requirements §29)
| # | Scenario | Verified by |
|---|---|---|
| 1 | Two simultaneous requests book the same slot | booking: same stylist/same time → exactly one wins, loser pays nothing; "any stylist" ×3 with 2 stylists → 2 succeed |
| 2 | Two requests spend the same wallet funds | booking (2 slots, ₹200) and ledger (12 × ₹30 vs ₹100 → exactly 3) |
| 3 | Same booking request submitted twice | 5 simultaneous identical requests → 1 booking, charged once; key reuse with a different body refused |
| 4 | Same payment webhook twice | ✅ sandbox **and** Razorpay-shaped traffic: 5 sequential, **10 / 8 simultaneous** deliveries → one credit; same payment under different event ids → one credit; webhook + verify + recovery racing → one credit. Mutation-checked. |
| 5 | Hold-release executed twice | ledger (4 concurrent releases → 1 posting) and booking (expiry event replayed) |
| 6 | Service completion executed twice | 3 concurrent completes → 1 success, 1 event, 1 settlement event |
| 7 | **Payout retried after timeout** | ✅ **both legs.** Payout: the provider created the transfer but the response was lost → the retry **found it by our reference and never called create again** (mutation-checked); request never reached the provider → created once; stuck payout re-driven by the sweeper without duplicating. Refund: same idea with Razorpay's `X-Refund-Idempotency` and the sandbox's key. *Against a sandbox and a test double, not a real provider.* |
| 8 | Booking creation fails during financial reservation | failure injected after the hold → everything rolled back |
| 9 | Reservation succeeds but a later op fails | failure injected after hold + reservation → both rolled back |
| 10 | Refund and settlement conflict | ledger release-vs-settle race ×6 → exactly one outcome, ledger balanced |

### What these results do and do NOT prove
- **Payment providers.** The test suites ran against **my own in-database simulators** and a **local test double of Razorpay**. They prove our code handles the failure modes I modelled. The Razorpay adapter has also been checked against the **REAL Razorpay test API**: `razorpay:check` (14 checks: auth, order creation, listing/paging limits, error shapes — it corrected three of my assumptions, ADR-0012) and, **now, a real payment lifecycle**: a ₹100 test payment completed through the customer app earlier today (captured 12:47 IST; I did not pay it) is in the dev database; a **₹10 refund issued from the admin portal was created at Razorpay (`rfnd_…`), and completed after the worker's recovery sweep**; the portal's payment reconciliation run against Razorpay matched the payment with no exceptions (§2b). **Still NOT verified against real Razorpay:** webhooks **delivered by Razorpay** (the redelivery checks used payloads **we signed ourselves** with the webhook secret — they prove our handling, not Razorpay's delivery; that needs a public URL), a refund idempotency-key **replay** at Razorpay, a failed payment, and capture behaviour under other account settings.
- **Money safety gates:** `REAL_MONEY_ENABLED=true`, a **live** Razorpay key (`rzp_live_…`), `PAYMENT_PROVIDER=razorpay` or `sandbox` in production, and `PAYOUT_PROVIDER=sandbox` in production are all refused at startup (config tests). No real money has moved and none can.
- **The wallet model is not legally cleared.** Choosing Razorpay does not decide whether a customer-funded multi-provider wallet needs RBI prepaid-instrument authorisation (my understanding, unverified — needs counsel). Q1–Q7 are still open.

### Not verified here
- **GitHub Actions workflow** — written, never run (no remote).
- Terraform and anything on AWS — none exists. The API image builds and runs locally (§2c); **no admin-portal image or compose stack file exists**, nothing has run on ECS, no image scan.
- Load/performance and the remaining OWASP review (planned Phase 9). The connection-pool design for the simulators (D12) has not been load-tested.
- Admin refund / payout operations over the compiled build are now exercised through the portal (§2b). A refund **idempotency-key replay at the real provider**, a payout against a real payout provider, and load/performance are not.

## 2. What exists

**`apps/api`** — NestJS 11 modular monolith (api + worker entry points from one image):

| Module | Delivered |
|---|---|
| `shared-kernel` | Money, UUIDv7, AES-GCM field encryption + blind indexes, config gates, redacting logger, RFC-7807 errors, Unit-of-Work, idempotency interceptor, transactional outbox + dispatcher, auth decorators |
| `audit` | append-only audit log (DB triggers) |
| `identity-access` | OTP login, rotating refresh tokens with reuse detection, instant revocation, scoped RBAC, admin password + TOTP MFA (privileged roles ineffective without MFA) |
| `provider-management` | registration, verification state machine, PostGIS locations, staff + consent-based invitations, directory facade (now also a provider-status lookup) |
| `catalog` | configurable categories (only Salon enabled), services/prices (versioned), staff skills, commission rules + cancellation policies (versioned), resolver |
| `availability` | hours/breaks/leave/openings, walk-in blocks, pure slot engine, reservations behind an exclusion constraint, policy |
| `geo-search` | PostGIS nearby search, map pins, public profile |
| `wallet-ledger` | immutable double-entry ledger, wallets, holds, reversals, refund reserve/complete/abort, **payout reserve/complete/abort**, **provider-payable credit events**, read-only balance facades, reconciliation + admin endpoint |
| `booking` | atomic request, explicit state machine, approve/reject/expire, cancellation by policy, no-show, QR/PIN arrival, start/complete, settlement, time-driven outbox events + sweeper |
| `payments` | `PaymentProvider` abstraction with **sandbox**, **Razorpay (test mode)** and **disabled** implementations; top-up intents; signature-verified, persisted, deduplicated webhooks; settlement from provider-fetched state only (`authorized` is never credited); quarantine on amount mismatch; recovery; refunds to source; reconciliation incl. refunds made outside the system (ADR-0011, ADR-0012) |
| **`settlement`** | provider **payables** (from the ledger), encrypted **bank accounts** with name-matched verification, cooling-off and change rate-limit, **payouts** (reserve → submit-after-commit → settle, query-before-retry, per-provider locking, packing under a cap, failure handling, automatic pause), provider earnings/payables/payouts views, finance operations (run, refresh, freeze/unfreeze), payout **reconciliation** and **integrity** checks (ADR-0013) |
| worker | outbox runner + housekeeping + payment recovery sweeper + **payout tick** (create due payouts, re-drive stuck ones) |

**Migrations (12, forward-only SQL)** · **CLIs:** `init-env`, `admin:create`, `seed:dev` · **Docs:** proposal, **ADR-0001…0013**.

### 2a. Mobile apps — what was run on the emulator (2026-10-07)
Flutter 3.47.6 / Dart 3.13.5, one pub workspace (`apps/mobile`: `tokengo_core`, `customer`, `provider`). Driven by hand through `adb` against the
real API and the real Postgres, with screenshots and database checks:

| Flow | Observed |
|---|---|
| Customer: discover → salon profile → booking flow (real slots) → request booking | `TG-VMWVS419` created: DB `REQUESTED`, funds `HELD`; wallet went ₹2,000 → ₹1,700 available + ₹300 reserved |
| Provider: sign in (separate app) → request appears with live response countdown → Accept | DB `CONFIRMED`, funds still `HELD`; the customer app updated by itself (15 s polling) and the refund preview changed ₹300 → ₹150 per the cancellation policy |
| Customer: Wallet → Add money → ₹100 | the **server created a real Razorpay TEST order** (`order_…`, ₹100, PENDING) and Razorpay's native Checkout opened with the correct amount |

**Not exercised:** a completed payment through Checkout (needs a person to pay with Razorpay test credentials), so the verify-and-credit path has been checked
only against fakes and against the earlier server-side e2e, not through the app; arrival / start / complete / no-show (the server correctly refuses them for a
booking tomorrow — covered by widget tests only); the wallet **map view**; cancel flow on the device; provider **earnings, payout and bank-account screens**
(compiled and unit-tested, not opened on the device); dark theme; any iOS build; accessibility; slow-network behaviour.

### 2b. Admin portal — what was run (2026-10-07)
Next.js 16 (`apps/admin`): a backend-for-frontend, so the browser never talks to the API (sealed HttpOnly session cookie, layered CSRF defence, default-deny proxy allowlist).
Driven in the in-app browser against the **compiled API + a separate worker process + real PostgreSQL + the real Razorpay TEST API**, signed in as test accounts created for
this (a platform administrator, then a finance operator; their credentials, TOTP secrets and recovery codes are only in git-ignored `apps/api/.env.dev-*` files).

| Area | Observed |
|---|---|
| Sign-in | wrong password → generic message + a reference id; password → authenticator enrolment (QR + typed key) → one-time recovery codes (cannot continue until acknowledged) → portal; sign out → "signed out" notice; returning sign-in with password + code |
| Navigation & permissions | platform admin sees every area; the finance operator sees no Users / Roles / Categories / Settings; **"Run payout batch" exists only for the finance role** (a platform admin holds `payout:read_any` but not `payout:operate` — separation of duties) |
| Providers | list, detail with audit history; Approve → confirmation dialog → provider `APPROVED`, audit `provider.approve` under the admin's id |
| Payouts (finance) | two real ledger settlements for a demo salon (posted with the compiled app code) → the **worker** recorded the payables (₹270) and verified the masked bank account → the **worker's own tick** created the payout before the manual "Run payout batch" (which correctly reported nothing to do) → Submitted → sandbox bank "paid" → portal *Refresh* → **Paid** with its UTR; payables Paid; one `PAYOUT_COMPLETE` posting, clearing account 0, every transaction balanced; payout integrity OK |
| Holds | freeze with a mandatory reason (shown on Holds, audited) and unfreeze |
| Refunds (finance) | over-limit amount refused in the form; ₹10 partial refund → Processing → the **worker created it at the real Razorpay test API** → **Succeeded** after the recovery sweep (the sweeper only touches refunds older than 5 min, runs every 2 min); `REFUND_RESERVE` + `REFUND_COMPLETE` posted, refund clearing 0; audit `refund.requested` / `refund.succeeded` |
| Reconciliation | payments run against real Razorpay: 1 matched, no exceptions; payout integrity OK |
| Webhooks | `pnpm --filter @tokengo/api razorpay:webhook-check` (12 checks) — signed payloads **made by us** for the real payment/refund: same event id deduplicated, same payment under other event ids and 6 simultaneous deliveries → one credit, wallet and ledger **unchanged**; forged / unsigned → 401; the page shows the states and outcomes |
| Catalog & settings | provider-scoped commission rule created (12 %, v1, in force; the platform default untouched); a setting changed with a before/after dialog (audited) and set back |
| Insight | dashboard (ledger + payout integrity, health), reports, audit log (records every action above) |
| Layout | phone (375 px) and desktop widths: no horizontal page overflow on the 7 pages measured (after W2); navigation drawer opens |
| **BFF security** | `pnpm --filter @tokengo/admin check:security` — **26 checks pass against the dev server and against the production build**: CSP + framing protection, `nosniff`, `no-referrer`, no `X-Powered-By`; foreign-Origin / missing-marker / `Sec-Fetch-Site: cross-site` sign-in refused; HttpOnly + `SameSite=Strict` + `Path=/` cookies; the session cookie is sealed; default-deny proxy and path traversal; **permissions enforced by the API itself** (finance gets 403 on settings through the BFF); mutating calls without / with a wrong CSRF token refused; **a session cookie replayed after sign-out is rejected (401)** (it worked before sign-out). Production defaults: `__Host-` + `Secure` cookies |

**Not exercised this session:** category enable/disable, the cancellation-policy form, user suspend / role grant (an earlier run's audit trail shows them done), idle timeout,
the dark/light toggle, other browsers, a screen reader, load. The admin portal has **no screens** for support cases / disputes, provider documents, review moderation,
notification deliveries, individual bookings or customer wallets (the API has endpoints for the first four) — see §4.

### 2c. Production image — what was run (2026-10-07)
`docker build -f apps/api/Dockerfile .` ✅ · the **`migrate` target** applied all 18 migrations to a fresh database from inside a container ✅ · the **API container** started
with `NODE_ENV=production` and every money provider `disabled`: healthy, `/api/v1/health/ready` → 200 with a database check ✅ · the **worker** started from the same image with
12 consumers ✅ · production **refused to start** (message read in each case) with `PAYMENT_PROVIDER=razorpay`, `REAL_MONEY_ENABLED=true`, `PAYOUT_PROVIDER=sandbox` and
`STORAGE_DRIVER=local` ✅. Production needs `S3_BUCKET` to boot (D20 follow-up: the prod-like env generator now sets a placeholder; uploads fail against it). **Not done:** an
admin-portal image, the compose stack file (the generator's header names `docker/docker-compose.stack.yml`, which does not exist), ECS/AWS, image scanning.


## 3. Defects found while building — root causes and fixes (requirements §37)

| # | Symptom | Root cause | Fix | Prevented by |
|---|---|---|---|---|
| D1 | Rebuild produced a half-empty `dist/` | `incremental: true` wrote `.tsbuildinfo` outside `dist/` | `incremental: false` for the build config | build twice in the e2e check |
| D2 | Admin login failed across CLI/API processes | PII keys were random per process | PII keys required outside tests | config tests |
| D3 | Outbox events not "due"; idempotency records expired wrongly | DB-default timestamps vs the application clock | writers stamp from the injected `Clock` | outbox/idempotency suites |
| D4 | Wrong slot counts on DST days / Lord Howe | alignment derived from wall-clock → UTC | alignment on instants (ADR-0008) | DST examples + oracle property test |
| D5 | Property test passed while checking little | generator produced mostly-empty weeks | dense generators + non-vacuity guard | the guard |
| D6 | Newest NestJS/Kysely majors are ESM-only | would force an ESM toolchain | pinned NestJS 11 / Kysely 0.28 | ADR-0002 |
| D7 | `ledger-is-a-leaf` boundary violated | wallet controller imported identity decorators | decorators moved to the shared kernel | dependency-cruiser |
| D8 | (review) idempotent hold replay would fail the funds check | funds checked before the idempotency lookup | replay lookup first | ledger test |
| D9 | Test-helper race (`reading 'address'` of null), cross-test OTP invalidation (recurred in payments) | supertest listens when a request is *created*; a login while it is pending closes the shared server | authenticate first, create the request second | booking + payments suites |
| D10 | The worker could not have started after payments was added | `WorkerModule` did not import `PaymentsModule` and no test booted the worker | explicit imports + `worker.int.spec.ts` (fails before the fix with the Nest error) | worker suite |
| D11 | A customer's refund line would read "processing" forever | the completing posting touches platform accounts only | neutral label; statement still cannot show pending-vs-sent (gap) | refund suite |
| D12 | (design review) possible connection-pool deadlock | the first sandbox borrowed the app's pool | simulators own a small pool | design; not load-tested |
| D13 | Genuine webhooks rejected (401) in the test harness | supertest JSON-stringifies a Buffer, corrupting the signed bytes (the rejection was *correct*) | send the exact bytes as a string | forged/tampered tests + real-HTTP e2e |
| D14 | A spy consumed by another test's refund; a failed setup leaked a database | shared outbox backlog; unguarded teardown | drain before each test; guarded teardown | refund + worker suites |
| **D15** | A legitimate provider named `D'Souza` would be rejected by bank-name matching | the tokenizer split on the apostrophe (`D`, `SOUZA`), but banks register `DSOUZA` | apostrophes/periods are removed, not word breaks | payout-rules unit test |
| **D16** | The service's own `VERIFIED → REPLACED` update would have been rejected by the database | the CHECK said `(status='VERIFIED') = (verified_at IS NOT NULL)`; a replaced account legitimately keeps `verified_at` | one-directional CHECK (`VERIFIED ⇒ verified_at`) — found in review before the first run | account-replace test asserts history is kept |
| **D17** | "One payout in flight per provider" had a race; and the first concurrency test could not have caught a missing lock | two runs could lock *disjoint* payables and both pass the in-flight check; the ledger's balance check silently masked it | per-provider advisory lock; the test now also asserts the ledger backstop *never fires* | mutation check (no locks → test fails) |
| **D18** | With payouts disabled (the production default) a new bank account would burn its retries and dead-letter | the consumer called a provider that refuses everything | a disabled provider leaves the account quietly pending | disabled-mode test |
| **D19** | (review before running) Razorpay 400/5xx/409 would escape unclassified from `createRefund`/`createOrder`/`listPayments` | those called the raw HTTP method, not the classifying one | single layered call path | Razorpay suite (400/401/409/500 cases) |
| **M1** | After a correct OTP the app stayed on the code screen | the server accepted the code and the session was stored, but go_router does not re-run `redirect` for screens opened with `push`, so "leave `/login*` once signed in" never fired | the code screen calls an explicit `onSignedIn`; the dead redirect was removed | `sign_in_flow_test` (customer), `sign_in_test` (provider) — confirmed red without the fix |
| **M2** | Back from a freshly booked appointment landed on a blank booking form | `pushReplacement` left the booking flow in the stack | booking detail is nested under the Bookings tab and opened with `go` | verified on the device |
| **M3** | First Android build impossible on this machine (three causes) | (a) the user's `%TEMP%` rejects Unix-domain sockets, which JDK 17's NIO selector uses on Windows → Gradle `Unable to establish loopback connection`; (b) Flutter provisions an NDK for *every* module and plugins defaulted to NDK 28 (~1.5 GB download); (c) Kotlin incremental caches cannot span drives (project on `E:`, pub cache on `C:`) | per-process `TEMP`, NDK pinned to the installed 27.1, `kotlin.incremental=false` | documented in the README and dev-environment notes |
| **M5** | The wallet statement showed a hold as two confusing lines, and the "held" test could never be true | the app compared the statement's `account` with `CUSTOMER_HELD`; the server sends `AVAILABLE` / `HELD`. My hand-written fixtures encoded the same wrong assumption, so every unit test passed | model fixed; hold legs collapsed for display; `HOLD_SETTLE` now reads as spending | `live_contract_test.dart` — parsers run over **real captured responses**; confirmed red with the old comparison. All other models were checked the same way and agree with the server |
| **M4** | The Razorpay checkout froze the emulator (Android "not responding") | the AVD had ~2 GB RAM and was swapping under the debug app + WebView; not an app defect | emulator relaunched with more RAM (flag only) | n/a — environment |
| **D20** | **The compiled API — and therefore the Docker image — could not start**: `Cannot find module 'multer'` | `document.controller.ts` and `support.controller.ts` import `multer` at runtime, but only `@types/multer` was declared; `multer` is a transitive dependency of `@nestjs/platform-express`, which pnpm does not link into our package. Jest passed anyway because pnpm's shims put its whole virtual store on `NODE_PATH`; plain `node dist/main.api.js` (production) has no such path | declared `multer` as a dependency | `declared-dependencies.unit.spec.ts`: transpiles every source file as `tsc` would and fails for any undeclared runtime package — **fails with `multer` removed**. (`seed-dev.ts` is exempted by name: it needs dev dependencies and refuses production) |
| D21 | 12 dispute-suite / state-machine tests failed after the previous session was cut off | all in the **tests**: they asserted booking statuses `DISPUTE` / `DISPUTE_RESOLVED` (the state machine and DB constraint use `DISPUTED` → `CLOSED`), the state-machine exhaustiveness count was not updated for the two dispute commands (13 → 15), `/notifications` was read without the required `?audience=`, a non-existent `audit.audit_log` was queried, the admin session helper re-logged in on every call (stale shared session → 401) and created supertest requests before awaiting a login (the D9 race) | tests corrected | the suites themselves |
| **W1** | On a phone the closed navigation drawer stayed in the tab order and the accessibility tree | it was only slid off-screen (`-translate-x-full`), not hidden: 21 links remained focusable | `max-lg:invisible` while closed, transitioned with the slide | `app-shell.test.tsx` (fails without the fix); checked in the browser (`visibility: hidden`, 0 focusable links) |
| **W2** | The Transactions page scrolled sideways by 81 px at 1024 px | a visually hidden `sr-only` "Actions" header is absolutely positioned and only clipped by a scroll container that is its containing block; the table's scroll wrapper was not positioned, so the span escaped it and widened the page | `relative` on the shared `TableCard` wrapper | measured overflow on 7 pages at 375 px and 1024 px |
| **W3** | Different records showed the same short id in tables (`01a115f4` for a user, a payout account and a payable) | ids are UUIDv7: the first 48 bits are a millisecond timestamp, so everything created within about a minute shares its first 8 characters | `shortId` shows `…` + the last 8 characters of a UUID (the random part); the three places that sliced by hand now use it | `format.test.ts` (two real ids with the same prefix) |
| W4 | Six staff permissions showed no description on the Roles / My access pages | the portal's permission catalogue was not extended when the support, documents, reviews and notifications permissions were added | descriptions added (each marked "not yet in the portal") | seen in the browser |

## 4. Known gaps and risks

1. **No live provider of any kind.** Razorpay is exercised in **test mode against a local double only**; payouts only against a sandbox. The payment model is undecided and needs counsel (wallet vs. per-booking capture vs. marketplace split); Q1–Q7 remain unanswered. The ledger is an internal book of record, **not** escrow.
2. **RazorpayX payouts and Razorpay Route** (marketplace split settlement) are separate Razorpay products needing their own accounts/agreements — **not built**. No payout webhooks (completion is learned by polling every 2 min and by operator refresh; a transfer returned by the bank *after* being paid is only caught by reconciliation).
3. **Payments follow-ups:** quarantined payments have no resolution workflow; the customer statement cannot show a refund pending-vs-sent; the webhook endpoint has no IP/rate throttling; no chargeback/dispute events; reconciliation is on demand, not scheduled and does not cover refunds' own settlement.
4. **Payout follow-ups:** clawbacks (refund after payout), maker-checker on freeze/unfreeze and bank-account overrides, tax (TDS/GST), per-day payout limits, provider notifications (events are published; nothing consumes them), stronger step-up authentication for bank-account changes.
5. **Superseded in part — needs a fresh review:** notification consumers, disputes/support, reviews and provider documents now exist as API modules (see the update at the top; their own test suites pass) but were **not exercised end to end by me**: no real SMS or FCM provider, no real S3, and additional charges (§9/G6) are still not built.
6. **Maker-checker** is not built for commission/cancellation changes. No password-reset or step-up re-auth for admins.
7. **Provider documents:** the API module and storage abstraction exist; malware scanning is not built, and S3 has never been exercised (local storage only in development).
8. **Scheduled ledger integrity / reconciliation runs** are available on demand but not yet scheduled by the worker.
9. Search availability enrichment is bounded (≤100 candidates) — to be load-tested.
10. IP throttling relies on `trust proxy = 1` (behind the ALB only). Hand-written Kysely table types can drift from SQL (integration tests are the guard).
11. Terraform and observability — not started. **Admin portal gaps:** no screens for **support cases and disputes** (a dispute freezes the booking's settlement and holds the money until staff decide, and today that decision can only be made through the raw API — the largest functional gap), provider-document review, review moderation, notification deliveries, bookings or customer wallets, and the BFF allowlist has no rules for them; **Settings → "Use default"** writes the default value back (the API has no reset), so the row stays "Customised"; the commission list does not show cancellation refund tiers (API change needed); no admin Dockerfile; maker-checker is still absent.
12. **Mobile:** no push notifications (the provider app polls every 30 s, the customer booking screen every 15 s); the provider app verifies arrival by **PIN only** (no QR scanner yet); Android debug builds only — no release signing, no iOS, no store assets; map tiles come from OpenStreetMap's public server, which its usage policy forbids for production; no offline cache, no localisation, no accessibility audit; **dev OTPs are printed in the API log** (no SMS provider). A provider with several businesses sees only the first approved one. Provider registration, location/service/staff management and document upload are not in the app (backend exists).
13. **Webhook for an unknown payment id** answers 503 (the provider would retry for about a day). Fine for a payment that is merely not visible yet; for one that is not ours it should probably be acknowledged and ignored — to be decided.
14. **Local environment:** `tg-infra-api-dev` is a leftover container from an older image (before the `multer` fix); `docker/docker-compose.stack.yml` does not exist although `docker/gen-stack-env.mjs` refers to it.

## 5. Suggested next steps

1. **Admin screens for support cases and disputes** (list, case with messages and evidence, assign, decide within the operator limit / above it) — plus provider-document review and review moderation. Disputes currently freeze money with no portal path to decide them.
2. **Answer Q1–Q7** (especially the wallet/payment model and who the legal entity is) — everything beyond test mode depends on it.
3. **Razorpay, remaining real-provider checks:** webhooks delivered by Razorpay itself (needs a public URL/tunnel), a refund idempotency-key replay, a failed payment. RazorpayX / Route adapters are separate products.
4. **Write the missing ADRs and status rows** for the admin portal, notifications, support/disputes, reviews, provider documents and account deletion; exercise each of those modules end to end (real FCM/SMS/S3 are not available here).
5. Quarantine resolution + refund state on the customer statement; scheduled integrity/reconciliation runs in the worker; payout webhooks.
6. Admin-portal Dockerfile and the compose stack file; Terraform; the first CI run (the workflow has never run — no remote). Finish the mobile device checks listed in §2a.
