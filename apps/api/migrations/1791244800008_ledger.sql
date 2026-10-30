-- Up Migration
-- Immutable double-entry ledger with a reservation/hold model (requirements §11, §12; proposal §J).
-- NOTHING here moves real money: it is the internal book of record. No row is ever updated or deleted
-- (except the cached balances on `accounts`, maintained by the ledger module and re-verified by the
-- integrity check) — corrections are compensating transactions.
CREATE SCHEMA IF NOT EXISTS ledger;

-- ===== Accounts ==============================================================================================
-- balance_minor is expressed in the account's NORMAL side: credit-normal (liabilities, revenue) =
-- credits - debits; debit-normal (assets, expenses) = debits - credits. Customer-facing liabilities may
-- never go negative: the database refuses it even if application code is wrong.
CREATE TABLE ledger.accounts (
  id            uuid PRIMARY KEY,
  owner_type    text        NOT NULL CHECK (owner_type IN ('CUSTOMER', 'PROVIDER', 'PLATFORM')),
  owner_id      uuid,
  account_type  text        NOT NULL CHECK (account_type IN (
    'CUSTOMER_AVAILABLE', 'CUSTOMER_HELD', 'PROVIDER_PAYABLE', 'PLATFORM_COMMISSION',
    'GATEWAY_CLEARING', 'PAYOUT_CLEARING', 'REFUND_CLEARING', 'ADJUSTMENT')),
  currency      char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  normal_side   text        NOT NULL CHECK (normal_side IN ('DEBIT', 'CREDIT')),
  balance_minor bigint      NOT NULL DEFAULT 0,
  last_seq      bigint      NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_owner_chk CHECK ((owner_type = 'PLATFORM') = (owner_id IS NULL)),
  CONSTRAINT accounts_customer_nonneg_chk CHECK (account_type NOT IN ('CUSTOMER_AVAILABLE', 'CUSTOMER_HELD') OR balance_minor >= 0),
  CONSTRAINT accounts_provider_payable_nonneg_chk CHECK (account_type <> 'PROVIDER_PAYABLE' OR balance_minor >= 0),
  CONSTRAINT accounts_clearing_nonneg_chk CHECK (account_type NOT IN ('PAYOUT_CLEARING', 'REFUND_CLEARING') OR balance_minor >= 0)
);
CREATE UNIQUE INDEX accounts_identity_key ON ledger.accounts
  (owner_type, COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), account_type, currency);

-- Platform accounts are fixed reference data (INR). Others are created per customer/provider on demand.
INSERT INTO ledger.accounts (id, owner_type, owner_id, account_type, currency, normal_side) VALUES
  ('00000000-0000-7000-8000-000000000401', 'PLATFORM', NULL, 'GATEWAY_CLEARING',    'INR', 'DEBIT'),
  ('00000000-0000-7000-8000-000000000402', 'PLATFORM', NULL, 'PLATFORM_COMMISSION', 'INR', 'CREDIT'),
  ('00000000-0000-7000-8000-000000000403', 'PLATFORM', NULL, 'PAYOUT_CLEARING',     'INR', 'CREDIT'),
  ('00000000-0000-7000-8000-000000000404', 'PLATFORM', NULL, 'REFUND_CLEARING',     'INR', 'CREDIT'),
  ('00000000-0000-7000-8000-000000000405', 'PLATFORM', NULL, 'ADJUSTMENT',          'INR', 'DEBIT');

-- ===== Customer wallets: the pair of ledger accounts a customer sees ========================================
CREATE TABLE ledger.wallet_accounts (
  customer_id          uuid PRIMARY KEY REFERENCES identity.users (id),
  currency             char(3)     NOT NULL,
  available_account_id uuid        NOT NULL UNIQUE REFERENCES ledger.accounts (id),
  held_account_id      uuid        NOT NULL UNIQUE REFERENCES ledger.accounts (id),
  status               text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ===== Transactions & entries (append-only) ====================================================================
CREATE TABLE ledger.transactions (
  id               uuid PRIMARY KEY,
  txn_type         text        NOT NULL,
  currency         char(3)     NOT NULL,
  business_ref_type text,
  business_ref_id  uuid,
  booking_id       uuid,
  idempotency_key  text        NOT NULL,
  reverses_txn_id  uuid        REFERENCES ledger.transactions (id),
  actor_type       text        NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM')),
  actor_id         uuid,
  correlation_id   text,
  audit_metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  posted_at        timestamptz NOT NULL,
  CONSTRAINT transactions_idempotency_key UNIQUE (idempotency_key)
);
-- A transaction can be compensated AT MOST once.
CREATE UNIQUE INDEX transactions_reverses_key ON ledger.transactions (reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;
CREATE INDEX transactions_booking_idx ON ledger.transactions (booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE ledger.entries (
  id                  uuid PRIMARY KEY,
  txn_id              uuid        NOT NULL REFERENCES ledger.transactions (id),
  account_id          uuid        NOT NULL REFERENCES ledger.accounts (id),
  direction           text        NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
  account_seq         bigint      NOT NULL,
  balance_after_minor bigint      NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entries_account_seq_key UNIQUE (account_id, account_seq)
);
CREATE INDEX entries_txn_idx ON ledger.entries (txn_id);
CREATE INDEX entries_account_idx ON ledger.entries (account_id, account_seq DESC);

-- Immutability: no UPDATE / DELETE / TRUNCATE on the books.
CREATE TRIGGER transactions_immutable BEFORE UPDATE OR DELETE ON ledger.transactions
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON ledger.transactions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_mutation();
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON ledger.entries
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON ledger.entries
  FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_mutation();

-- Every transaction must balance: sum(debits) = sum(credits), with at least two entries. Checked at COMMIT
-- (deferred) so entries can be inserted one by one.
CREATE FUNCTION ledger.assert_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d bigint;
  c bigint;
  n integer;
BEGIN
  SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0),
         COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0),
         COUNT(*)
    INTO d, c, n
    FROM ledger.entries WHERE txn_id = NEW.txn_id;
  IF d <> c OR n < 2 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (debits %, credits %, entries %)', NEW.txn_id, d, c, n
      USING ERRCODE = '23000';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger.entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_txn_balanced();

-- ===== Holds: funds reserved against a booking ==================================================================
CREATE TABLE ledger.holds (
  id               uuid PRIMARY KEY,
  booking_id       uuid        NOT NULL,
  customer_id      uuid        NOT NULL REFERENCES ledger.wallet_accounts (customer_id),
  purpose          text        NOT NULL CHECK (purpose IN ('BOOKING', 'ADDITIONAL_CHARGE')),
  amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
  currency         char(3)     NOT NULL,
  status           text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED', 'SETTLED')),
  funding_source   text        NOT NULL DEFAULT 'WALLET' CHECK (funding_source IN ('WALLET', 'PSP_AUTHORIZATION')),
  create_txn_id    uuid        NOT NULL REFERENCES ledger.transactions (id),
  close_txn_id     uuid        REFERENCES ledger.transactions (id),
  close_reason     text,
  created_at       timestamptz NOT NULL,
  closed_at        timestamptz,
  CONSTRAINT holds_close_consistency_chk CHECK ((status = 'ACTIVE') = (close_txn_id IS NULL AND closed_at IS NULL))
);
-- One ACTIVE hold per (booking, purpose).
CREATE UNIQUE INDEX holds_active_key ON ledger.holds (booking_id, purpose) WHERE status = 'ACTIVE';
CREATE INDEX holds_booking_idx ON ledger.holds (booking_id);
CREATE INDEX holds_customer_idx ON ledger.holds (customer_id) WHERE status = 'ACTIVE';

-- A closed hold is frozen: it can never be reopened, re-closed, or have its amount changed.
CREATE FUNCTION ledger.guard_hold_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'hold % is already % and cannot be modified', OLD.id, OLD.status USING ERRCODE = '23000';
  END IF;
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.booking_id <> OLD.booking_id OR NEW.customer_id <> OLD.customer_id THEN
    RAISE EXCEPTION 'hold % amount/booking/customer are immutable', OLD.id USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER holds_guard BEFORE UPDATE ON ledger.holds FOR EACH ROW EXECUTE FUNCTION ledger.guard_hold_update();
CREATE TRIGGER holds_no_delete BEFORE DELETE ON ledger.holds FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

INSERT INTO identity.permissions (code, description) VALUES
  ('wallet:read_any',   'View any customer wallet (support, masked)'),
  ('ledger:read',       'View the ledger and integrity reports');
INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('SUPPORT_OPERATOR', 'wallet:read_any'),
  ('FINANCE_OPERATOR', 'wallet:read_any'),
  ('FINANCE_OPERATOR', 'ledger:read'),
  ('PLATFORM_ADMIN',   'ledger:read')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
