-- Up Migration
-- Commission + cancellation rules (configurable, effective-dated, versioned — requirements §19/§20 and
-- "do not hardcode"), extra booking-policy settings, and the booking aggregate (requirements §15/§16).

-- ===== Commission rules ==============================================================================
-- Most specific wins: PROVIDER_SERVICE > PROVIDER > SERVICE_TYPE > CATEGORY > PLATFORM. A rule is never
-- edited in place: to change it, close the old version (effective_to) and add a new one. The rule applied to
-- a booking is SNAPSHOTTED into the booking, so later changes never alter history.
CREATE TABLE catalog.commission_rules (
  id             uuid PRIMARY KEY,
  scope_type     text        NOT NULL CHECK (scope_type IN ('PLATFORM', 'CATEGORY', 'SERVICE_TYPE', 'PROVIDER', 'PROVIDER_SERVICE')),
  scope_id       uuid,
  kind           text        NOT NULL CHECK (kind IN ('PERCENT', 'FIXED')),
  percent_bps    integer     CHECK (percent_bps BETWEEN 0 AND 10000),
  fixed_minor    bigint      CHECK (fixed_minor >= 0),
  currency       char(3)     NOT NULL DEFAULT 'INR',
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  version        integer     NOT NULL DEFAULT 1,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rules_scope_chk CHECK ((scope_type = 'PLATFORM') = (scope_id IS NULL)),
  CONSTRAINT commission_rules_kind_chk CHECK (
    (kind = 'PERCENT' AND percent_bps IS NOT NULL AND fixed_minor IS NULL) OR
    (kind = 'FIXED' AND fixed_minor IS NOT NULL AND percent_bps IS NULL)
  ),
  CONSTRAINT commission_rules_window_chk CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT commission_rules_no_overlap EXCLUDE USING gist (
    scope_type WITH =,
    (COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);
CREATE INDEX commission_rules_lookup_idx ON catalog.commission_rules (scope_type, scope_id);

-- Only `effective_to` may change after insert (closing a version).
CREATE FUNCTION catalog.guard_rule_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.scope_type <> OLD.scope_type OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR to_jsonb(NEW) - 'effective_to' <> to_jsonb(OLD) - 'effective_to' THEN
    RAISE EXCEPTION 'rules are versioned: close the old version and insert a new one' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commission_rules_guard BEFORE UPDATE ON catalog.commission_rules FOR EACH ROW EXECUTE FUNCTION catalog.guard_rule_update();
CREATE TRIGGER commission_rules_no_delete BEFORE DELETE ON catalog.commission_rules FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- Illustrative platform default (10 %, requirements §19 example) — CONFIGURATION, changeable by versioning.
INSERT INTO catalog.commission_rules (id, scope_type, scope_id, kind, percent_bps, effective_from, version)
VALUES ('00000000-0000-7000-8000-000000000501', 'PLATFORM', NULL, 'PERCENT', 1000, '2020-01-01T00:00:00Z', 1);

-- ===== Cancellation policies ============================================================================
CREATE TABLE catalog.cancellation_policies (
  id                         uuid PRIMARY KEY,
  name                       text        NOT NULL,
  scope_type                 text        NOT NULL CHECK (scope_type IN ('PLATFORM', 'CATEGORY', 'PROVIDER')),
  scope_id                   uuid,
  no_show_refund_bps         integer     NOT NULL DEFAULT 0 CHECK (no_show_refund_bps BETWEEN 0 AND 10000),
  provider_cancel_refund_bps integer     NOT NULL DEFAULT 10000 CHECK (provider_cancel_refund_bps BETWEEN 0 AND 10000),
  effective_from             timestamptz NOT NULL,
  effective_to               timestamptz,
  version                    integer     NOT NULL DEFAULT 1,
  created_by                 uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cancellation_policies_scope_chk CHECK ((scope_type = 'PLATFORM') = (scope_id IS NULL)),
  CONSTRAINT cancellation_policies_window_chk CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT cancellation_policies_no_overlap EXCLUDE USING gist (
    scope_type WITH =,
    (COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);
-- Refund tiers: cancelling at least `min_hours_before` hours before the start refunds `refund_bps` of the
-- amount; the tier with the LARGEST applicable min_hours_before wins.
CREATE TABLE catalog.cancellation_policy_tiers (
  policy_id        uuid    NOT NULL REFERENCES catalog.cancellation_policies (id),
  min_hours_before integer NOT NULL CHECK (min_hours_before >= 0),
  refund_bps       integer NOT NULL CHECK (refund_bps BETWEEN 0 AND 10000),
  PRIMARY KEY (policy_id, min_hours_before)
);
CREATE TRIGGER cancellation_tiers_immutable BEFORE UPDATE OR DELETE ON catalog.cancellation_policy_tiers
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
CREATE TRIGGER cancellation_policies_guard BEFORE UPDATE ON catalog.cancellation_policies FOR EACH ROW EXECUTE FUNCTION catalog.guard_rule_update();
CREATE TRIGGER cancellation_policies_no_delete BEFORE DELETE ON catalog.cancellation_policies FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

INSERT INTO catalog.cancellation_policies (id, name, scope_type, scope_id, no_show_refund_bps, provider_cancel_refund_bps, effective_from)
VALUES ('00000000-0000-7000-8000-000000000511', 'Platform default', 'PLATFORM', NULL, 0, 10000, '2020-01-01T00:00:00Z');
INSERT INTO catalog.cancellation_policy_tiers (policy_id, min_hours_before, refund_bps) VALUES
  ('00000000-0000-7000-8000-000000000511', 24, 10000),
  ('00000000-0000-7000-8000-000000000511', 2,   5000),
  ('00000000-0000-7000-8000-000000000511', 0,      0);

-- ===== More booking-policy settings (still configuration, platform default + provider override) =========
ALTER TABLE scheduling.booking_policies
  ADD COLUMN check_in_window_min  smallint CHECK (check_in_window_min BETWEEN 0 AND 720),
  ADD COLUMN no_show_grace_min    smallint CHECK (no_show_grace_min BETWEEN 0 AND 240),
  ADD COLUMN settlement_hold_hours smallint CHECK (settlement_hold_hours BETWEEN 0 AND 168);
UPDATE scheduling.booking_policies
   SET check_in_window_min = 30, no_show_grace_min = 15, settlement_hold_hours = 24
 WHERE scope_type = 'PLATFORM';
ALTER TABLE scheduling.booking_policies DROP CONSTRAINT booking_policies_platform_complete_chk;
ALTER TABLE scheduling.booking_policies ADD CONSTRAINT booking_policies_platform_complete_chk CHECK (
  scope_type <> 'PLATFORM' OR (
    slot_granularity_min IS NOT NULL AND min_lead_time_min IS NOT NULL AND max_advance_days IS NOT NULL
    AND response_deadline_min IS NOT NULL AND check_in_window_min IS NOT NULL
    AND no_show_grace_min IS NOT NULL AND settlement_hold_hours IS NOT NULL
  )
);

-- ===== The booking aggregate ===============================================================================
CREATE SCHEMA IF NOT EXISTS booking;

CREATE TABLE booking.bookings (
  id                   uuid PRIMARY KEY,
  booking_ref          text        NOT NULL,
  customer_id          uuid        NOT NULL REFERENCES identity.users (id),
  provider_id          uuid        NOT NULL REFERENCES provider.providers (id),
  location_id          uuid        NOT NULL REFERENCES provider.provider_locations (id),
  resource_id          uuid        NOT NULL REFERENCES provider.bookable_resources (id),
  reservation_id       uuid        NOT NULL REFERENCES scheduling.resource_reservations (id),
  -- DRAFT / PAYMENT_PENDING / PAYMENT_HELD are reserved for the per-booking-payment model (proposal G3);
  -- the wallet model creates bookings directly in REQUESTED.
  status               text        NOT NULL CHECK (status IN (
    'DRAFT', 'PAYMENT_PENDING', 'PAYMENT_HELD', 'REQUESTED', 'CONFIRMED', 'PROVIDER_REJECTED', 'EXPIRED',
    'CUSTOMER_CANCELLED', 'PROVIDER_CANCELLED', 'NO_SHOW', 'CUSTOMER_ARRIVED', 'SERVICE_STARTED',
    'SERVICE_COMPLETED', 'DISPUTED', 'CLOSED')),
  -- Payment/settlement are modelled SEPARATELY from the lifecycle (requirements §15).
  funds_status         text        NOT NULL DEFAULT 'NONE' CHECK (funds_status IN ('NONE', 'HELD', 'RELEASED', 'SETTLED', 'PARTIAL')),
  settlement_status    text        NOT NULL DEFAULT 'NOT_DUE' CHECK (settlement_status IN ('NOT_DUE', 'PENDING', 'FROZEN', 'DONE')),
  start_at             timestamptz NOT NULL,
  end_at               timestamptz NOT NULL,       -- customer-visible end (start + duration)
  occupied_until       timestamptz NOT NULL,       -- end + buffer: what the reservation holds
  response_deadline_at timestamptz,
  settle_after         timestamptz,
  requested_at         timestamptz NOT NULL,
  confirmed_at         timestamptz,
  arrived_at           timestamptz,
  started_at           timestamptz,
  completed_at         timestamptz,
  closed_at            timestamptz,
  customer_note        text,
  status_reason        text,
  idempotency_key      text        NOT NULL,
  version              integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_ref_key UNIQUE (booking_ref),
  CONSTRAINT bookings_customer_idem_key UNIQUE (customer_id, idempotency_key),
  CONSTRAINT bookings_time_chk CHECK (end_at > start_at AND occupied_until >= end_at)
);
CREATE INDEX bookings_customer_idx ON booking.bookings (customer_id, created_at DESC);
CREATE INDEX bookings_provider_idx ON booking.bookings (provider_id, start_at);
CREATE INDEX bookings_location_idx ON booking.bookings (location_id, start_at);
CREATE INDEX bookings_resource_idx ON booking.bookings (resource_id, start_at);
CREATE INDEX bookings_deadline_idx ON booking.bookings (response_deadline_at) WHERE status = 'REQUESTED';
CREATE INDEX bookings_settle_idx ON booking.bookings (settle_after) WHERE settlement_status = 'PENDING';
CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON booking.bookings FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Immutable pricing snapshot per line (requirements §9): later price changes never touch history.
CREATE TABLE booking.booking_items (
  id                  uuid PRIMARY KEY,
  booking_id          uuid    NOT NULL REFERENCES booking.bookings (id),
  provider_service_id uuid    NOT NULL,
  service_version     integer NOT NULL,
  name                text    NOT NULL,
  price_minor         bigint  NOT NULL CHECK (price_minor >= 0),
  currency            char(3) NOT NULL,
  duration_min        integer NOT NULL,
  buffer_min          integer NOT NULL
);
CREATE INDEX booking_items_booking_idx ON booking.booking_items (booking_id);

-- Financial snapshot: the commission rule and cancellation policy IN FORCE when the booking was requested.
CREATE TABLE booking.booking_financials (
  booking_id                uuid PRIMARY KEY REFERENCES booking.bookings (id),
  currency                  char(3) NOT NULL,
  gross_minor               bigint  NOT NULL CHECK (gross_minor >= 0),
  discount_minor            bigint  NOT NULL DEFAULT 0,
  tax_minor                 bigint  NOT NULL DEFAULT 0,
  commission_rule_id        uuid,
  commission_rule_version   integer,
  commission_kind           text    NOT NULL CHECK (commission_kind IN ('PERCENT', 'FIXED')),
  commission_bps            integer,
  commission_fixed_minor    bigint,
  cancellation_policy       jsonb   NOT NULL,
  hold_id                   uuid
);
CREATE TRIGGER booking_items_immutable BEFORE UPDATE OR DELETE ON booking.booking_items FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- Append-only history of every significant transition (requirements §15).
CREATE TABLE booking.booking_events (
  id          uuid PRIMARY KEY,
  booking_id  uuid        NOT NULL REFERENCES booking.bookings (id),
  event_type  text        NOT NULL,
  from_status text,
  to_status   text,
  actor_type  text        NOT NULL CHECK (actor_type IN ('CUSTOMER', 'PROVIDER', 'ADMIN', 'SYSTEM')),
  actor_id    uuid,
  reason_code text,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX booking_events_booking_idx ON booking.booking_events (booking_id, occurred_at, id);
CREATE TRIGGER booking_events_immutable BEFORE UPDATE OR DELETE ON booking.booking_events FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
CREATE TRIGGER booking_events_no_truncate BEFORE TRUNCATE ON booking.booking_events FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_mutation();

-- Arrival verification attempt tracking (PIN brute-force protection)
CREATE TABLE booking.booking_verifications (
  booking_id      uuid PRIMARY KEY REFERENCES booking.bookings (id),
  failed_attempts integer     NOT NULL DEFAULT 0,
  locked_until    timestamptz
);

-- ===== Permissions ===========================================================================================
INSERT INTO identity.permissions (code, description) VALUES
  ('appointment:create',    'Request a booking as a customer'),
  ('appointment:respond',   'Approve or reject booking requests'),
  ('appointment:run',       'Verify arrival, start and complete services'),
  ('appointment:read',      'View a location''s appointments'),
  ('appointment:cancel',    'Cancel a confirmed booking on the provider side'),
  ('appointment:read_any',  'View any booking (support/admin/finance)'),
  ('pricing:read',          'View commission rules and cancellation policies'),
  ('pricing:manage',        'Create new versions of commission rules and cancellation policies');
INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('CUSTOMER',         'appointment:create'),
  ('PROVIDER_OWNER',   'appointment:respond'),
  ('PROVIDER_OWNER',   'appointment:run'),
  ('PROVIDER_OWNER',   'appointment:read'),
  ('PROVIDER_OWNER',   'appointment:cancel'),
  ('PROVIDER_MANAGER', 'appointment:respond'),
  ('PROVIDER_MANAGER', 'appointment:run'),
  ('PROVIDER_MANAGER', 'appointment:read'),
  ('PROVIDER_MANAGER', 'appointment:cancel'),
  ('PROVIDER_STAFF',   'appointment:run'),
  ('PROVIDER_STAFF',   'appointment:read'),
  ('SUPPORT_OPERATOR', 'appointment:read_any'),
  ('FINANCE_OPERATOR', 'appointment:read_any'),
  ('PLATFORM_ADMIN',   'appointment:read_any'),
  ('PLATFORM_ADMIN',   'pricing:read'),
  ('PLATFORM_ADMIN',   'pricing:manage'),
  ('FINANCE_OPERATOR', 'pricing:read')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
