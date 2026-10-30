-- Up Migration
-- Extensions required by the design (docs §B.1): PostGIS for geo search, btree_gist for the
-- scheduling exclusion constraint, pgcrypto for gen_random_uuid() fallbacks.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS audit;

-- Generic helpers ---------------------------------------------------------------------------
CREATE FUNCTION platform.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Used on every append-only table (audit now; ledger, booking_events later).
CREATE FUNCTION platform.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: this table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '23000';
END;
$$;

-- Idempotency (docs §L.1 #1) ----------------------------------------------------------------
CREATE TABLE platform.idempotency_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL,
  scope           text        NOT NULL,
  idempotency_key text        NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_status integer,
  response_body   jsonb,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  CONSTRAINT idempotency_records_unique_key UNIQUE (principal_id, scope, idempotency_key)
);
CREATE INDEX idempotency_records_expires_idx ON platform.idempotency_records (expires_at);
CREATE TRIGGER idempotency_records_updated_at BEFORE UPDATE ON platform.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Transactional outbox (docs §L.1 #6) -------------------------------------------------------
CREATE TABLE platform.outbox_events (
  id             uuid PRIMARY KEY,
  aggregate_type text        NOT NULL,
  aggregate_id   uuid,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  headers        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status         text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  attempts       integer     NOT NULL DEFAULT 0,
  available_at   timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_events_pending_idx ON platform.outbox_events (available_at) WHERE status = 'PENDING';

-- Fixed-window rate-limit counters (OTP/login throttling; no Redis in v1, docs §B.1) ---------
CREATE TABLE platform.rate_limit_counters (
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limit_counters_window_idx ON platform.rate_limit_counters (window_start);

-- Audit log: append-only (requirements §30) -------------------------------------------------
CREATE TABLE audit.audit_logs (
  id          uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type  text        NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM')),
  actor_id    uuid,
  action      text        NOT NULL,
  entity_type text        NOT NULL,
  entity_id   text,
  request_id  text,
  before_data jsonb,
  after_data  jsonb,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_logs_entity_idx ON audit.audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx  ON audit.audit_logs (actor_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit.audit_logs (action, occurred_at DESC);

CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit.audit_logs
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid_mutation();

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
