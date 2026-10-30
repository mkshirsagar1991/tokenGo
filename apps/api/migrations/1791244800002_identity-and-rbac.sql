-- Up Migration
CREATE SCHEMA IF NOT EXISTS identity;

-- Users. PII is stored encrypted (AES-256-GCM, app-side) with an HMAC blind index for lookup (docs §M.1).
CREATE TABLE identity.users (
  id            uuid PRIMARY KEY,
  phone_hash    text        NOT NULL,
  phone_enc     bytea       NOT NULL,
  email_enc     bytea,
  status        text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'DELETED')),
  locale        text        NOT NULL DEFAULT 'en',
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_phone_hash_key ON identity.users (phone_hash);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON identity.users
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- OTP challenges: the code is stored only as a keyed hash; attempts are bounded (requirements §24).
CREATE TABLE identity.otp_challenges (
  id               uuid PRIMARY KEY,
  phone_hash       text        NOT NULL,
  code_hash        text        NOT NULL,
  purpose          text        NOT NULL DEFAULT 'LOGIN',
  expires_at       timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  max_attempts     integer     NOT NULL CHECK (max_attempts > 0),
  consumed_at      timestamptz,
  requested_ip_hash text,
  device_id        text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_idx ON identity.otp_challenges (phone_hash, created_at DESC);

-- Sessions = refresh-token families. One session per device login (docs §M.1).
CREATE TABLE identity.auth_sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES identity.users (id),
  device_id    text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  revoke_reason text
);
CREATE INDEX auth_sessions_user_idx ON identity.auth_sessions (user_id) WHERE revoked_at IS NULL;

-- Refresh tokens rotate on every use. Presenting an already-rotated token is a REUSE signal and
-- revokes the whole session (token-theft detection). Only a hash of the token is stored.
CREATE TABLE identity.refresh_tokens (
  id         uuid PRIMARY KEY,
  session_id uuid        NOT NULL REFERENCES identity.auth_sessions (id) ON DELETE CASCADE,
  token_hash text        NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz
);
CREATE UNIQUE INDEX refresh_tokens_hash_key ON identity.refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_session_idx ON identity.refresh_tokens (session_id);

-- RBAC: permissions are fixed strings `resource:action`; roles bundle them; assignments are scoped ----
CREATE TABLE identity.permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+:[a-z_]+$'),
  description text NOT NULL
);

CREATE TABLE identity.roles (
  id         uuid PRIMARY KEY,
  code       text        NOT NULL UNIQUE,
  name       text        NOT NULL,
  scope_type text        NOT NULL CHECK (scope_type IN ('PLATFORM', 'PROVIDER', 'LOCATION')),
  is_system  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, scope_type)
);

CREATE TABLE identity.role_permissions (
  role_id         uuid NOT NULL REFERENCES identity.roles (id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES identity.permissions (code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE identity.role_assignments (
  id         uuid PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES identity.users (id),
  role_id    uuid        NOT NULL,
  scope_type text        NOT NULL,
  scope_id   uuid,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  valid_to   timestamptz,
  revoked_at timestamptz,
  -- The assignment's scope type must match the role's declared scope type (declarative, not app-only).
  CONSTRAINT role_assignments_role_scope_fk FOREIGN KEY (role_id, scope_type)
    REFERENCES identity.roles (id, scope_type),
  CONSTRAINT role_assignments_scope_id_chk CHECK (
    (scope_type = 'PLATFORM' AND scope_id IS NULL) OR (scope_type <> 'PLATFORM' AND scope_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX role_assignments_active_key ON identity.role_assignments
  (user_id, role_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX role_assignments_user_idx ON identity.role_assignments (user_id) WHERE revoked_at IS NULL;

-- Reference data: initial permission catalogue and system roles (extended by later phases) -------
INSERT INTO identity.permissions (code, description) VALUES
  ('category:manage',     'Create/update/enable categories and service types'),
  ('provider:register',   'Register a business as a service provider'),
  ('provider:update',     'Update own provider profile'),
  ('provider:read_any',   'Read any provider (administration)'),
  ('provider:verify',     'Approve or reject provider verification'),
  ('provider:suspend',    'Suspend or reinstate a provider'),
  ('location:manage',     'Manage provider locations'),
  ('service:manage',      'Manage the provider service catalogue and prices'),
  ('service:read',        'View the provider service catalogue'),
  ('staff:manage',        'Create and manage provider staff'),
  ('staff:read',          'View provider staff'),
  ('role:assign',         'Assign or revoke roles'),
  ('user:read_any',       'Read any user (masked)'),
  ('audit:read',          'Read the audit log');

INSERT INTO identity.roles (id, code, name, scope_type) VALUES
  ('00000000-0000-7000-8000-000000000001', 'CUSTOMER',         'Customer',                 'PLATFORM'),
  ('00000000-0000-7000-8000-000000000002', 'PROVIDER_OWNER',   'Service provider owner',   'PROVIDER'),
  ('00000000-0000-7000-8000-000000000003', 'PROVIDER_MANAGER', 'Service provider manager', 'LOCATION'),
  ('00000000-0000-7000-8000-000000000004', 'PROVIDER_STAFF',   'Service provider staff',   'LOCATION'),
  ('00000000-0000-7000-8000-000000000005', 'PLATFORM_ADMIN',   'Platform administrator',   'PLATFORM'),
  ('00000000-0000-7000-8000-000000000006', 'SUPPORT_OPERATOR', 'Platform support operator','PLATFORM'),
  ('00000000-0000-7000-8000-000000000007', 'FINANCE_OPERATOR', 'Finance / reconciliation operator', 'PLATFORM');

INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('CUSTOMER',         'provider:register'),
  ('PROVIDER_OWNER',   'provider:update'),
  ('PROVIDER_OWNER',   'location:manage'),
  ('PROVIDER_OWNER',   'service:manage'),
  ('PROVIDER_OWNER',   'service:read'),
  ('PROVIDER_OWNER',   'staff:manage'),
  ('PROVIDER_OWNER',   'staff:read'),
  ('PROVIDER_MANAGER', 'staff:read'),
  ('PROVIDER_MANAGER', 'service:read'),
  ('PROVIDER_STAFF',   'staff:read'),
  ('PROVIDER_STAFF',   'service:read'),
  ('PLATFORM_ADMIN',   'category:manage'),
  ('PLATFORM_ADMIN',   'provider:read_any'),
  ('PLATFORM_ADMIN',   'provider:verify'),
  ('PLATFORM_ADMIN',   'provider:suspend'),
  ('PLATFORM_ADMIN',   'role:assign'),
  ('PLATFORM_ADMIN',   'user:read_any'),
  ('PLATFORM_ADMIN',   'audit:read'),
  ('SUPPORT_OPERATOR', 'provider:read_any'),
  ('SUPPORT_OPERATOR', 'user:read_any'),
  ('FINANCE_OPERATOR', 'provider:read_any'),
  ('FINANCE_OPERATOR', 'audit:read')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
