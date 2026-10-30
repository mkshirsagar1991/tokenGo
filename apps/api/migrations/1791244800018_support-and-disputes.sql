-- Up Migration
-- Customer support and disputes (requirements §5/§6/§20/§21). One case model for both: a QUESTION is a conversation with support;
-- a DISPUTE is a case about a completed booking whose money is frozen until an administrator decides (the decision itself is
-- carried out by the booking engine and the ledger, never by this module's own bookkeeping).
CREATE SCHEMA IF NOT EXISTS support;

CREATE TABLE support.cases (
  id                      uuid        PRIMARY KEY,
  case_ref                text        NOT NULL UNIQUE,
  kind                    text        NOT NULL CHECK (kind IN ('QUESTION', 'DISPUTE')),
  status                  text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'AWAITING_CUSTOMER', 'AWAITING_PROVIDER', 'IN_REVIEW', 'RESOLVED', 'CLOSED')),
  opened_by               uuid        NOT NULL REFERENCES identity.users (id),
  opened_by_role          text        NOT NULL CHECK (opened_by_role IN ('CUSTOMER', 'PROVIDER')),
  -- The two parties of a booking-related case; either may be null for a general question.
  customer_id             uuid        REFERENCES identity.users (id),
  provider_id             uuid        REFERENCES provider.providers (id),
  booking_id              uuid        REFERENCES booking.bookings (id),
  category                text        NOT NULL CHECK (length(category) BETWEEN 2 AND 40),
  subject                 text        NOT NULL CHECK (length(subject) BETWEEN 3 AND 140),
  assigned_to             uuid        REFERENCES identity.users (id),
  -- The decision on a dispute.
  resolution_outcome      text        CHECK (resolution_outcome IN ('RELEASE_TO_PROVIDER', 'REFUND_CUSTOMER', 'PARTIAL_REFUND')),
  resolution_refund_minor bigint      CHECK (resolution_refund_minor >= 0),
  resolution_note         text        CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  resolved_by             uuid,
  resolved_at             timestamptz,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  closed_at               timestamptz,
  CONSTRAINT cases_dispute_needs_booking_chk CHECK (kind <> 'DISPUTE' OR (booking_id IS NOT NULL AND customer_id IS NOT NULL AND provider_id IS NOT NULL)),
  CONSTRAINT cases_resolution_chk CHECK ((resolution_outcome IS NULL) = (resolved_at IS NULL)),
  CONSTRAINT cases_dispute_status_chk CHECK (kind = 'DISPUTE' OR status <> 'RESOLVED')
);
-- A booking can be disputed once: the money is decided once.
CREATE UNIQUE INDEX cases_one_dispute_per_booking ON support.cases (booking_id) WHERE kind = 'DISPUTE';
CREATE INDEX cases_status_idx   ON support.cases (status, id DESC);
CREATE INDEX cases_customer_idx ON support.cases (customer_id, id DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX cases_provider_idx ON support.cases (provider_id, id DESC) WHERE provider_id IS NOT NULL;
CREATE INDEX cases_assigned_idx ON support.cases (assigned_to, status) WHERE assigned_to IS NOT NULL;

CREATE TABLE support.messages (
  id          uuid        PRIMARY KEY,
  case_id     uuid        NOT NULL REFERENCES support.cases (id),
  author_id   uuid        REFERENCES identity.users (id),
  author_role text        NOT NULL CHECK (author_role IN ('CUSTOMER', 'PROVIDER', 'ADMIN', 'SYSTEM')),
  body        text        NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  -- Internal notes are visible to administrators only.
  internal    boolean     NOT NULL DEFAULT FALSE,
  created_at  timestamptz NOT NULL,
  CONSTRAINT messages_internal_admin_chk CHECK (NOT internal OR author_role = 'ADMIN')
);
CREATE INDEX messages_case_idx ON support.messages (case_id, id);

-- Evidence (photos, receipts). The file lives in object storage; this row says whose it is and what it is.
CREATE TABLE support.attachments (
  id            uuid        PRIMARY KEY,
  case_id       uuid        NOT NULL REFERENCES support.cases (id),
  uploaded_by   uuid        NOT NULL REFERENCES identity.users (id),
  uploaded_role text        NOT NULL CHECK (uploaded_role IN ('CUSTOMER', 'PROVIDER', 'ADMIN')),
  storage_key   text        NOT NULL UNIQUE,
  content_type  text        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes    integer     NOT NULL CHECK (size_bytes > 0),
  sha256        text        NOT NULL,
  original_name text        CHECK (original_name IS NULL OR length(original_name) <= 100),
  created_at    timestamptz NOT NULL
);
CREATE INDEX attachments_case_idx ON support.attachments (case_id, created_at);

INSERT INTO identity.permissions (code, description) VALUES
  ('support:contact',      'Open and answer support cases for own business'),
  ('support:handle',       'See the support queue and answer, assign and close cases (administration)'),
  ('dispute:resolve',      'Decide a dispute up to the operator refund limit'),
  ('dispute:resolve_large','Decide a dispute above the operator refund limit');
INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('PROVIDER_OWNER',   'support:contact'),
  ('PROVIDER_MANAGER', 'support:contact'),
  ('SUPPORT_OPERATOR', 'support:handle'),
  ('SUPPORT_OPERATOR', 'dispute:resolve'),
  ('PLATFORM_ADMIN',   'support:handle'),
  ('PLATFORM_ADMIN',   'dispute:resolve'),
  ('PLATFORM_ADMIN',   'dispute:resolve_large')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
