# TokenGo

Multi-vertical service marketplace (Salon first): customer app, provider app, admin portal and one backend.

- 📐 **Design:** [`docs/ARCHITECTURE-PROPOSAL.md`](docs/ARCHITECTURE-PROPOSAL.md) — architecture, state machines, ledger/hold design, security, AWS, phases, risks.
- 🧾 **Decisions:** [`docs/adr/`](docs/adr)
- ✅ **Where we are:** [`docs/STATUS.md`](docs/STATUS.md) — verified results, defects & root causes, open gaps, next steps.
- 📋 **Source requirements:** [`requiremnts.md`](requiremnts.md)

> Real-money payment flows are **disabled** and will stay so until the payment-model and regulatory review (proposal §K.4) is approved. The API refuses to start with `REAL_MONEY_ENABLED=true`.

## Repository layout

```
apps/api/            NestJS modular monolith — API (main.api.ts) and worker (main.worker.ts) from one image
  migrations/        forward-only SQL migrations (node-pg-migrate)
  src/shared-kernel/ Money, ids, crypto, config, logging, errors, Unit-of-Work, idempotency, outbox
  src/modules/       audit · identity-access · provider-management · catalog · availability · geo-search · wallet-ledger · booking · payments · settlement · noti fications · support · reviews · platform
  src/worker/        outbox runner + housekeeping
  src/cli/           create-admin (bootstrap), seed-dev (demo data)
  test/              integration tests (real PostgreSQL + PostGIS) and harness
apps/admin/          Next.js admin portal: a backend-for-frontend, the browser never talks to the API directly (port 3100)
apps/mobile/         Flutter workspace: customer app (TokenGo), provider app (TokenGo Business), shared core — see apps/mobile/README.md
apk/                 built Android packages for testers (git-ignored; made by apps/mobile/tool/build-apks.ps1)
docker/              local PostGIS, production-image helpers
docs/                architecture, ADRs, status
```
Not created yet: `infra/` (Terraform), an image for the admin portal, any hosting.

## Quick start (backend)

Prerequisites: Node 22+, pnpm 9, Docker.

```bash
pnpm install
pnpm db:up                       # PostGIS on localhost:55432 (throwaway local credentials)
pnpm api:init-env                # writes apps/api/.env with NEW local-only secrets (git-ignored). Keep it:
                                 #   the PII keys define stored data and must stay stable across restarts.
pnpm api:migrate                 # applies apps/api/migrations to DATABASE_URL
pnpm --filter @tokengo/api build
pnpm --filter @tokengo/api seed:dev        # demo ABC Salon / XYZ Salon / Style Studio (dev only; prints a one-time admin password)
pnpm api:dev                     # http://localhost:3000/api/v1   ·   Swagger: /api/docs
pnpm --filter @tokengo/api start:worker    # (separate terminal) outbox worker
```

In development the SMS adapter prints the OTP to the server log (`[DEV SMS] …`), so you can sign in without a gateway:

```bash
curl -X POST localhost:3000/api/v1/auth/otp/request -H 'content-type: application/json' -d '{"phone":"9000000021"}'
# read the code from the server log, then:
curl -X POST localhost:3000/api/v1/auth/otp/verify  -H 'content-type: application/json' -d '{"phone":"9000000021","code":"<code>"}'
```

Try discovery without logging in:

```bash
curl 'localhost:3000/api/v1/search/providers?lat=18.5308&lng=73.8475&radius_m=15000&service_type=haircut'
```

**Administrators** cannot be created through the API. Bootstrap the first one (password only via the environment, never an argument):

```bash
ADMIN_PHONE=9876543210 ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='a long passphrase' pnpm --filter @tokengo/api admin:create
```
The first sign-in (`POST /api/v1/auth/admin/login`) forces enrolment of an authenticator app; privileged roles have **no effect** in a session that has not completed MFA.

## See it running: admin portal and phone apps

With the backend running (database, API on `:3000`, worker — see above):

**Admin portal** (Next.js, port 3100). Its server talks to the API; `apps/admin/.env.local` holds the API address and a random session secret (`pnpm --filter @tokengo/admin init-env` writes it).

```bash
pnpm --filter @tokengo/admin build
# Plain http on a LAN needs COOKIE_SECURE=false (in production the cookies are Secure and __Host- prefixed).
# ALLOWED_ORIGINS must list every OTHER address you will open the portal from, e.g. your PC's Wi-Fi address.
# Do NOT pass --hostname: the portal compares the browser's Origin with the address it was started on and refuses every sign-in that does not match.
COOKIE_SECURE=false ALLOWED_ORIGINS=http://<pc-address>:3100 pnpm --filter @tokengo/admin start    # -> http://localhost:3100
pnpm --filter @tokengo/admin dev                                                                  # same, with hot reload
pnpm --filter @tokengo/admin check:security     # 26 black-box security checks against what is running on :3100 (needs a finance test account; see the script header)
```
Sign in with an administrator made by `admin:create` (above). The first sign-in shows a QR code for an authenticator app and one-time recovery codes. Roles matter: only `FINANCE_OPERATOR` can run payouts or refunds; `PLATFORM_ADMIN` cannot. There are no portal screens yet for support cases/disputes, provider documents or review moderation (STATUS.md §4).

**Phone apps (Android).** The API address is compiled into the app; on a real phone it is your PC's address on the shared Wi-Fi, never `localhost` or `10.0.2.2`:

```powershell
.\apps\mobile\tool\build-apks.ps1     # -> apk\TokenGo-customer-arm64.apk and apk\TokenGo-business-arm64.apk (about 20 MB each; arm32 variants for old phones)
```
These are small optimized **profile** builds (signed with the debug key): the internal test build, which is allowed plain `http://` to the dev API (`src/profile/AndroidManifest.xml`). A **release** build stays HTTPS-only and needs an HTTPS API (not available yet). The phone must be on the same network as the PC, the API and worker must be running, and Windows Firewall must allow Node on that network. Login codes are printed in the API log (no SMS provider yet). Details and limits: [`apps/mobile/README.md`](apps/mobile/README.md).

## Payments and payouts (test mode / sandbox only — no real money)

Wallet top-ups and refunds go through a `PaymentProvider` abstraction (ADR-0011) with three implementations: an **in-database sandbox** (default locally), **Razorpay in TEST MODE** (ADR-0012) and `disabled` (the production default). Provider payouts use their own abstraction with a sandbox only (ADR-0013). Startup **refuses**: `REAL_MONEY_ENABLED=true`, a live Razorpay key (`rzp_live_…`), `razorpay` or `sandbox` payments in production, and a sandbox payout provider in production.

```bash
# customer: ask to add ₹500 (Idempotency-Key required) -> returns the intent + checkout details
POST /api/v1/payments/intents           {"amount_minor": 50000}
# sandbox only: "complete checkout"; with Razorpay the app opens Razorpay Checkout using checkout.key_id + checkout.order_id
POST /api/v1/payments/sandbox/pay       {"intent_id": "…", "outcome": "SUCCESS"}
# either way: the wallet is credited only after the SERVER has asked the provider (also recovers a lost callback)
POST /api/v1/payments/intents/:id/verify
```
**To try Razorpay test mode:** set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (see `apps/api/.env.example`), enable auto-capture in the dashboard, and point a webhook at `/api/v1/payments/webhooks/razorpay`. Until this has been run against a real Razorpay test account the integration is verified **only against a local test double**.

**Providers** set a bank account (`PUT /api/v1/providers/:id/payout-account`, stored encrypted, shown masked, bank-checked, cooled off before first use) and see `earnings`, `payables` and `payouts`. **Finance** (MFA session) runs and monitors payouts, reconciles, freezes providers and reads integrity under `/api/v1/admin/payouts…`, `/admin/payables`, `/admin/payout-accounts`, `/admin/payments/*`. The worker creates due payouts and settles lost callbacks on its own.

## Quality gates

```bash
pnpm --filter @tokengo/api lint
pnpm --filter @tokengo/api typecheck
pnpm --filter @tokengo/api depcheck      # module-boundary rules (ADR-0001)
pnpm --filter @tokengo/api test:unit
pnpm --filter @tokengo/api test:int      # needs PostgreSQL+PostGIS: TEST_DATABASE_URL (default = docker-compose DB)
pnpm --filter @tokengo/api build
```

`TEST_DATABASE_URL` must be an **admin** connection (e.g. `postgres://…/postgres`); each test file gets its own cloned database. Spatial suites are *skipped (and reported as skipped)* on a server without PostGIS — see ADR-0004. `PROPERTY_RUNS=300` raises the slot-engine property test.

## Conventions worth knowing

- Money is integer **minor units** (`bigint` in the DB, `Money` in code). The API never accepts totals, prices from clients for bookings, or statuses — only explicit command endpoints.
- Every route is authenticated unless marked `@Public()`; authorization is enforced server-side per object (ADR-0006).
- Commands that must not run twice carry `Idempotency-Key` (ADR-0007); double-booking is prevented by a database exclusion constraint (ADR-0008).
- Modules talk through `src/modules/<name>/index.ts` only; CI fails otherwise.
