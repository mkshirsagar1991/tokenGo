-- Up Migration
-- Centralised notifications (requirements §26): in-app notifications are the system of record; push is a delivery channel with
-- its own retry/status tracking. Created from outbox events, so a notification failure can never corrupt a booking or money.
CREATE SCHEMA IF NOT EXISTS notification;

CREATE TABLE notification.notifications (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES identity.users (id),
  -- A person can be both a customer and a business owner: each app lists only its own audience.
  audience   text        NOT NULL CHECK (audience IN ('CUSTOMER', 'PROVIDER')),
  category   text        NOT NULL CHECK (category IN ('BOOKING', 'REMINDER', 'WALLET', 'PAYOUT', 'REVIEW', 'SUPPORT')),
  kind       text        NOT NULL,
  title      text        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body       text        NOT NULL CHECK (length(body) BETWEEN 1 AND 400),
  -- Ids only (booking_id, ...): the app uses them to open the right screen. Never PII.
  data       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Retried events must not notify twice: one notification per (user, dedupe_key).
  dedupe_key text        NOT NULL,
  created_at timestamptz NOT NULL,
  read_at    timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_idx   ON notification.notifications (user_id, audience, id DESC);
CREATE INDEX notifications_unread_idx ON notification.notifications (user_id, audience) WHERE read_at IS NULL;

CREATE TABLE notification.devices (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES identity.users (id),
  app          text        NOT NULL CHECK (app IN ('CUSTOMER', 'PROVIDER')),
  platform     text        NOT NULL CHECK (platform IN ('ANDROID', 'IOS')),
  -- The push token is a credential for sending to a device: stored encrypted, looked up by a keyed hash.
  token_hash   text        NOT NULL UNIQUE,
  token_enc    bytea       NOT NULL,
  locale       text,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX devices_user_idx ON notification.devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE notification.deliveries (
  id                  uuid        PRIMARY KEY,
  notification_id     uuid        NOT NULL REFERENCES notification.notifications (id) ON DELETE CASCADE,
  channel             text        NOT NULL CHECK (channel IN ('PUSH')),
  device_id           uuid        NOT NULL REFERENCES notification.devices (id),
  status              text        NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts            integer     NOT NULL DEFAULT 0,
  last_error          text,
  provider_message_id text,
  created_at          timestamptz NOT NULL,
  sent_at             timestamptz,
  UNIQUE (notification_id, channel, device_id)
);
CREATE INDEX deliveries_status_idx ON notification.deliveries (status, created_at) WHERE status IN ('PENDING', 'FAILED');

-- Per-category push preference. Absence of a row = enabled. The in-app list is unaffected by it.
CREATE TABLE notification.preferences (
  user_id      uuid    NOT NULL REFERENCES identity.users (id),
  category     text    NOT NULL CHECK (category IN ('BOOKING', 'REMINDER', 'WALLET', 'PAYOUT', 'REVIEW', 'SUPPORT')),
  push_enabled boolean NOT NULL,
  PRIMARY KEY (user_id, category)
);

INSERT INTO identity.permissions (code, description) VALUES
  ('notification:read_any', 'View notification delivery status across users (no message content)');
INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('PLATFORM_ADMIN',   'notification:read_any'),
  ('SUPPORT_OPERATOR', 'notification:read_any')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
