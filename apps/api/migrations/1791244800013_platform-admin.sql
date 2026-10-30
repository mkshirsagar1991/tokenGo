-- Up Migration
-- Platform administration: typed settings (changed through the admin portal, audited), plus the permissions the new
-- admin read/ops endpoints are guarded by. The settings KEYS and their validation live in code (a registry); this table only
-- stores overrides, so an unknown key can never be persisted.

CREATE TABLE platform.settings (
  key        text        PRIMARY KEY CHECK (key ~ '^[a-z0-9_.]+$'),
  value      jsonb       NOT NULL,
  version    integer     NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO identity.permissions (code, description) VALUES
  ('settings:manage', 'Change platform settings'),
  ('report:read',     'View platform reports'),
  ('user:suspend',    'Suspend or reinstate a user account'),
  ('role:read',       'View roles and who holds them');

INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('PLATFORM_ADMIN',   'settings:manage'),
  ('PLATFORM_ADMIN',   'report:read'),
  ('PLATFORM_ADMIN',   'user:suspend'),
  ('PLATFORM_ADMIN',   'role:read'),
  ('FINANCE_OPERATOR', 'report:read'),
  ('SUPPORT_OPERATOR', 'role:read')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
