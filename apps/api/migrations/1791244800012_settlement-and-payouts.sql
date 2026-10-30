-- Up Migration
-- Settlement & payouts (requirements §19, §28; proposal §G/§K). A PAYABLE is money the platform OWES a provider; a PAYOUT is a
-- bank transfer that has been asked for. They are different things and are modelled separately: a payable is not money already
-- paid into the provider's bank account. Nothing here moves real money — the only payout provider is a sandbox simulator.
CREATE SCHEMA IF NOT EXISTS settlement;

-- ===== Where a provider is paid ===============================================================================
-- Bank details are personal/financial data: the account number and the holder's name are encrypted with the field cipher;
-- only the last four digits and the IFSC (a branch code) are kept readable. The blind index (HMAC) lets finance find
-- "which providers share this account" without ever decrypting.
CREATE TABLE settlement.payout_accounts (
  id                 uuid PRIMARY KEY,
  provider_id        uuid        NOT NULL REFERENCES provider.providers (id),
  holder_name_enc    bytea       NOT NULL,
  account_number_enc bytea       NOT NULL,
  ifsc               text        NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_last4      text        NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  account_hash       text        NOT NULL,
  status             text        NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (status IN ('PENDING_VERIFICATION', 'VERIFIED', 'VERIFICATION_FAILED', 'REPLACED')),
  verification_ref   text        NOT NULL UNIQUE,   -- our idempotent reference for the bank-account check
  failure_reason     text,
  verified_at        timestamptz,
  created_by         uuid        NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  -- A VERIFIED account always says when. (A REPLACED account keeps its verified_at as history, so this is one-directional.)
  CONSTRAINT payout_accounts_verified_chk CHECK (status <> 'VERIFIED' OR verified_at IS NOT NULL)
);
-- At most ONE live destination per provider. Replacing the account swaps it atomically and the new one must be verified first.
CREATE UNIQUE INDEX payout_accounts_one_live ON settlement.payout_accounts (provider_id) WHERE status IN ('PENDING_VERIFICATION', 'VERIFIED');
CREATE INDEX payout_accounts_hash_idx ON settlement.payout_accounts (account_hash);
CREATE INDEX payout_accounts_pending_idx ON settlement.payout_accounts (created_at) WHERE status = 'PENDING_VERIFICATION';

-- A row here means "do not pay this provider" (set by finance, or automatically after repeated payout failures).
CREATE TABLE settlement.payout_holds (
  provider_id uuid PRIMARY KEY REFERENCES provider.providers (id),
  reason      text        NOT NULL,
  held_by     uuid,
  automatic   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL
);

-- ===== Payouts ===================================================================================================
-- RESERVED  money moved payable -> payout_clearing; not (known to be) with the provider yet. An UNKNOWN outcome stays here and
--           is resolved by QUERYING the provider by our reference — never by blindly sending again.
-- SUBMITTED the provider has it (queued / processing)
-- PAID      the bank confirmed; payout_clearing -> gateway_clearing
-- FAILED    the provider refused or reversed it before paying; the reservation was compensated
CREATE TABLE settlement.payouts (
  id                  uuid PRIMARY KEY,
  provider_id         uuid        NOT NULL REFERENCES provider.providers (id),
  payout_account_id   uuid        NOT NULL REFERENCES settlement.payout_accounts (id),
  currency            char(3)     NOT NULL,
  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
  status              text        NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'SUBMITTED', 'PAID', 'FAILED')),
  provider_name       text        NOT NULL,
  provider_reference  text        NOT NULL,          -- OUR idempotent reference (= this id); the provider's idempotency key
  provider_payout_id  text,
  utr                 text,                           -- the bank's transaction reference once paid
  provider_created_at timestamptz,
  attempts            integer     NOT NULL DEFAULT 0,
  last_error          text,
  failure_reason      text,
  needs_review        boolean     NOT NULL DEFAULT false,  -- the provider and our books disagree after a terminal state: a human must look
  reserve_txn_id      uuid,
  close_txn_id        uuid,
  created_at          timestamptz NOT NULL,
  submitted_at        timestamptz,
  completed_at        timestamptz,
  updated_at          timestamptz NOT NULL,
  CONSTRAINT payouts_reference_key UNIQUE (provider_name, provider_reference),
  -- A payout cannot be final in the books without the ledger posting that made it final.
  CONSTRAINT payouts_final_has_ledger_chk CHECK (status NOT IN ('PAID', 'FAILED') OR close_txn_id IS NOT NULL),
  CONSTRAINT payouts_reserved_has_ledger_chk CHECK (reserve_txn_id IS NOT NULL)
);
CREATE UNIQUE INDEX payouts_provider_payout_key ON settlement.payouts (provider_name, provider_payout_id) WHERE provider_payout_id IS NOT NULL;
CREATE INDEX payouts_open_idx ON settlement.payouts (created_at) WHERE status IN ('RESERVED', 'SUBMITTED');
CREATE INDEX payouts_provider_idx ON settlement.payouts (provider_id, created_at DESC);
CREATE INDEX payouts_review_idx ON settlement.payouts (created_at) WHERE needs_review;

-- ===== What the provider is owed ================================================================================
-- One row per settlement posting that credited the provider's payable (recorded from the ledger's own event, so every path —
-- completion, cancellation fee, no-show — is covered). ACCRUED -> IN_PAYOUT -> PAID; a failed payout returns rows to ACCRUED.
CREATE TABLE settlement.provider_payables (
  id               uuid PRIMARY KEY,
  provider_id      uuid        NOT NULL REFERENCES provider.providers (id),
  ledger_txn_id    uuid        NOT NULL,
  booking_id       uuid,
  currency         char(3)     NOT NULL,
  net_minor        bigint      NOT NULL CHECK (net_minor > 0),
  commission_minor bigint      NOT NULL DEFAULT 0 CHECK (commission_minor >= 0),
  status           text        NOT NULL DEFAULT 'ACCRUED' CHECK (status IN ('ACCRUED', 'IN_PAYOUT', 'PAID', 'CLAWED_BACK')),
  eligible_at      timestamptz NOT NULL,
  payout_id        uuid        REFERENCES settlement.payouts (id),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CONSTRAINT provider_payables_posting_key UNIQUE (ledger_txn_id, provider_id),
  CONSTRAINT provider_payables_payout_chk CHECK ((status IN ('IN_PAYOUT', 'PAID')) = (payout_id IS NOT NULL))
);
CREATE INDEX provider_payables_eligible_idx ON settlement.provider_payables (provider_id, eligible_at, id) WHERE status = 'ACCRUED';
CREATE INDEX provider_payables_booking_idx ON settlement.provider_payables (booking_id);
CREATE INDEX provider_payables_payout_idx ON settlement.provider_payables (payout_id) WHERE payout_id IS NOT NULL;

-- Permanent record of which payables were put in which payout (provider_payables.payout_id only holds the CURRENT assignment,
-- which is cleared when a payout fails and the payables become payable again).
CREATE TABLE settlement.payout_items (
  payout_id  uuid NOT NULL REFERENCES settlement.payouts (id),
  payable_id uuid NOT NULL REFERENCES settlement.provider_payables (id),
  PRIMARY KEY (payout_id, payable_id)
);
CREATE INDEX payout_items_payable_idx ON settlement.payout_items (payable_id);

-- ===== Reconciliation against the payout provider's own records ================================================
CREATE TABLE settlement.reconciliation_runs (
  id            uuid PRIMARY KEY,
  provider_name text        NOT NULL,
  period_from   timestamptz NOT NULL,
  period_to     timestamptz NOT NULL,
  started_by    uuid,
  matched       integer     NOT NULL DEFAULT 0,
  exceptions    integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL
);
CREATE TABLE settlement.reconciliation_records (
  id             uuid PRIMARY KEY,
  run_id         uuid        NOT NULL REFERENCES settlement.reconciliation_runs (id),
  status         text        NOT NULL CHECK (status IN ('MATCHED', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'MISSING_INTERNAL', 'MISSING_EXTERNAL')),
  external_ref   text,
  internal_ref   uuid,
  expected_minor bigint,
  actual_minor   bigint,
  detail         text,
  created_at     timestamptz NOT NULL
);
CREATE INDEX settlement_reconciliation_records_run_idx ON settlement.reconciliation_records (run_id, status);

-- ===== Sandbox simulator state (dev/test only; PAYOUT_PROVIDER=sandbox, refused in production) =====================
CREATE TABLE settlement.sandbox_bank_checks (
  reference      text PRIMARY KEY,
  account_hash   text        NOT NULL,
  name_at_bank   text,
  status         text        NOT NULL CHECK (status IN ('VERIFIED', 'FAILED', 'PENDING')),
  failure_reason text,
  created_at     timestamptz NOT NULL
);
CREATE TABLE settlement.sandbox_payouts (
  provider_payout_id text PRIMARY KEY,
  reference          text        NOT NULL UNIQUE,
  amount_minor       bigint      NOT NULL,
  currency           char(3)     NOT NULL,
  destination_last4  text        NOT NULL,
  status             text        NOT NULL CHECK (status IN ('QUEUED', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED')),
  utr                text,
  failure_reason     text,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);

-- ===== Permissions ==============================================================================================
INSERT INTO identity.permissions (code, description) VALUES
  ('payout_account:manage', 'Set and view the provider payout bank account'),
  ('earnings:read',         'View own earnings, payables and payouts'),
  ('payout:read_any',       'View any provider''s payables, payouts and payout account (masked)'),
  ('payout:operate',        'Run payouts, refresh them, freeze or unfreeze a provider'),
  ('payout:reconcile',      'Reconcile payouts against the payout provider');
INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('PROVIDER_OWNER',   'payout_account:manage'),
  ('PROVIDER_OWNER',   'earnings:read'),
  ('FINANCE_OPERATOR', 'payout:read_any'),
  ('FINANCE_OPERATOR', 'payout:operate'),
  ('FINANCE_OPERATOR', 'payout:reconcile'),
  ('SUPPORT_OPERATOR', 'payout:read_any'),
  ('PLATFORM_ADMIN',   'payout:read_any')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
