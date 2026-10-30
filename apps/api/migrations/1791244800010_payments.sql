-- Up Migration
-- Payments (requirements §14; proposal §K). SANDBOX ONLY: nothing here talks to a real payment provider
-- and no real money moves. The provider is an abstraction; `sandbox_*` tables back the in-database
-- simulator and are used only when PAYMENT_PROVIDER=sandbox (refused in production).
CREATE SCHEMA IF NOT EXISTS payments;

-- ===== Payment intents (a customer's request to add funds) =====================================================
CREATE TABLE payments.payment_intents (
  id                uuid PRIMARY KEY,
  customer_id       uuid        NOT NULL REFERENCES identity.users (id),
  purpose           text        NOT NULL DEFAULT 'WALLET_TOPUP' CHECK (purpose IN ('WALLET_TOPUP')),
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  currency          char(3)     NOT NULL,
  provider          text        NOT NULL,
  provider_order_id text        NOT NULL,
  -- PENDING until the PSP confirms capture SERVER-SIDE. A late capture after EXPIRED is still credited:
  -- the money was taken, so the book must follow reality.
  status            text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'EXPIRED', 'CANCELLED')),
  idempotency_key   text        NOT NULL,
  expires_at        timestamptz NOT NULL,
  succeeded_at      timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_order_key UNIQUE (provider, provider_order_id),
  CONSTRAINT payment_intents_customer_idem_key UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX payment_intents_pending_idx ON payments.payment_intents (created_at) WHERE status = 'PENDING';
CREATE INDEX payment_intents_customer_idx ON payments.payment_intents (customer_id, created_at DESC);

-- One row per payment ATTEMPT at the PSP (an intent can have several: failed card, then UPI succeeds).
CREATE TABLE payments.payment_transactions (
  id                  uuid PRIMARY KEY,
  intent_id           uuid        NOT NULL REFERENCES payments.payment_intents (id),
  provider            text        NOT NULL,
  provider_payment_id text        NOT NULL,
  -- CAPTURED   = money taken AND credited to the wallet (ledger_txn_id is mandatory).
  -- QUARANTINED = money taken but NOT credited because it does not match the intent (amount/currency); needs a human.
  -- FAILED      = the attempt did not capture.
  status              text        NOT NULL CHECK (status IN ('CAPTURED', 'FAILED', 'QUARANTINED')),
  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),    -- what the PROVIDER says it captured
  currency            char(3)     NOT NULL,
  ledger_txn_id       uuid,
  provider_created_at timestamptz NOT NULL,                              -- the PSP's own timestamp (reconciliation window)
  verified_at         timestamptz NOT NULL,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- A PSP payment id can be recorded once: this is what makes duplicate callbacks harmless.
  CONSTRAINT payment_transactions_provider_payment_key UNIQUE (provider, provider_payment_id),
  -- The book can never say "captured" without the matching ledger transaction.
  CONSTRAINT payment_transactions_captured_has_ledger CHECK (status <> 'CAPTURED' OR ledger_txn_id IS NOT NULL)
);
CREATE INDEX payment_transactions_intent_idx ON payments.payment_transactions (intent_id);
CREATE INDEX payment_transactions_quarantined_idx ON payments.payment_transactions (created_at) WHERE status = 'QUARANTINED';
CREATE INDEX payment_transactions_provider_time_idx ON payments.payment_transactions (provider, provider_created_at);

-- ===== Webhook inbox (persist everything, process idempotently) ============================================
CREATE TABLE payments.webhook_events (
  id                uuid PRIMARY KEY,
  provider          text        NOT NULL,
  provider_event_id text,
  event_type        text,
  signature_valid   boolean     NOT NULL,
  payload           jsonb,
  processing_status text        NOT NULL DEFAULT 'RECEIVED' CHECK (processing_status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'REJECTED', 'FAILED')),
  attempts          integer     NOT NULL DEFAULT 0,
  outcome           text,                          -- what processing actually did (e.g. CREDITED, ALREADY_PROCESSED)
  last_error        text,
  received_at       timestamptz NOT NULL,
  processed_at      timestamptz,
  -- Unauthenticated input never lands in a keyed column: a forged event can therefore never occupy (and so
  -- block) the dedupe key of the genuine one.
  CONSTRAINT webhook_events_unverified_has_no_event_id CHECK (signature_valid OR (provider_event_id IS NULL AND payload IS NULL))
);
-- NULLs are distinct, so rejected events (event id NULL) never collide; every authenticated event is deduplicated.
CREATE UNIQUE INDEX webhook_events_dedupe_key ON payments.webhook_events (provider, provider_event_id);
CREATE INDEX webhook_events_received_idx ON payments.webhook_events (received_at DESC);

-- ===== Refunds to the original payment instrument ===========================================================
CREATE TABLE payments.refunds (
  id                      uuid PRIMARY KEY,
  payment_transaction_id  uuid        NOT NULL REFERENCES payments.payment_transactions (id),
  customer_id             uuid        NOT NULL REFERENCES identity.users (id),
  amount_minor            bigint      NOT NULL CHECK (amount_minor > 0),
  currency                char(3)     NOT NULL,
  status                  text        NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'SUCCEEDED', 'FAILED')),
  provider                text        NOT NULL,
  provider_refund_id      text,
  reason                  text        NOT NULL,
  requested_by            uuid        NOT NULL,
  idempotency_key         text        NOT NULL,
  reserve_txn_id          uuid,
  close_txn_id            uuid,
  failure_reason          text,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_idempotency_key UNIQUE (requested_by, idempotency_key)
);
CREATE UNIQUE INDEX refunds_provider_refund_key ON payments.refunds (provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE INDEX refunds_payment_idx ON payments.refunds (payment_transaction_id);

-- ===== Reconciliation against the provider's own records =====================================================
CREATE TABLE payments.reconciliation_runs (
  id         uuid PRIMARY KEY,
  provider   text        NOT NULL,
  period_from timestamptz NOT NULL,
  period_to  timestamptz NOT NULL,
  started_by uuid,
  matched    integer     NOT NULL DEFAULT 0,
  exceptions integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);
CREATE TABLE payments.reconciliation_records (
  id            uuid PRIMARY KEY,
  run_id        uuid        NOT NULL REFERENCES payments.reconciliation_runs (id),
  status        text        NOT NULL CHECK (status IN ('MATCHED', 'AMOUNT_MISMATCH', 'MISSING_INTERNAL', 'MISSING_EXTERNAL')),
  external_ref  text,
  internal_ref  uuid,
  expected_minor bigint,
  actual_minor  bigint,
  detail        text,
  created_at    timestamptz NOT NULL
);
CREATE INDEX reconciliation_records_run_idx ON payments.reconciliation_records (run_id, status);

-- ===== Sandbox simulator state (dev/test only) ==================================================================
CREATE TABLE payments.sandbox_orders (
  provider_order_id text PRIMARY KEY,
  amount_minor      bigint      NOT NULL,
  currency          char(3)     NOT NULL,
  receipt           text UNIQUE,
  created_at        timestamptz NOT NULL
);
CREATE TABLE payments.sandbox_payments (
  provider_payment_id text PRIMARY KEY,
  provider_order_id   text        NOT NULL REFERENCES payments.sandbox_orders (provider_order_id),
  amount_minor        bigint      NOT NULL,
  currency            char(3)     NOT NULL,
  status              text        NOT NULL CHECK (status IN ('CAPTURED', 'FAILED')),
  created_at          timestamptz NOT NULL
);
-- Like a real PSP, an order can be paid (captured) at most once; earlier attempts may have failed.
CREATE UNIQUE INDEX sandbox_payments_one_capture_per_order ON payments.sandbox_payments (provider_order_id) WHERE status = 'CAPTURED';
CREATE TABLE payments.sandbox_refunds (
  provider_refund_id  text PRIMARY KEY,
  provider_payment_id text        NOT NULL REFERENCES payments.sandbox_payments (provider_payment_id),
  amount_minor        bigint      NOT NULL,
  idempotency_key     text        NOT NULL UNIQUE,   -- like a real PSP: the same key returns the same refund
  status              text        NOT NULL CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
  created_at          timestamptz NOT NULL
);

-- ===== Permissions ============================================================================================
INSERT INTO identity.permissions (code, description) VALUES
  ('wallet:topup',        'Add funds to the own wallet'),
  ('refund:create',       'Initiate a refund to the original payment instrument'),
  ('payments:read',       'View payments, refunds and reconciliation results'),
  ('payments:reconcile',  'Run payment reconciliation against the provider');
INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('CUSTOMER',         'wallet:topup'),
  ('FINANCE_OPERATOR', 'refund:create'),
  ('FINANCE_OPERATOR', 'payments:read'),
  ('FINANCE_OPERATOR', 'payments:reconcile'),
  ('PLATFORM_ADMIN',   'payments:read'),
  ('SUPPORT_OPERATOR', 'payments:read')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
