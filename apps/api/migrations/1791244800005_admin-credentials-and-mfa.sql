-- Up Migration
-- Privileged accounts (requirements §4/§24): password (Argon2id) + TOTP MFA. Privileged permissions are
-- only effective inside a session that completed MFA; a bare OTP/SIM-swapped login never carries them.

ALTER TABLE identity.roles ADD COLUMN requires_mfa boolean NOT NULL DEFAULT false;
UPDATE identity.roles SET requires_mfa = true
 WHERE code IN ('PLATFORM_ADMIN', 'SUPPORT_OPERATOR', 'FINANCE_OPERATOR');

-- A session records when (if ever) it passed MFA.
ALTER TABLE identity.auth_sessions ADD COLUMN mfa_verified_at timestamptz;

CREATE TABLE identity.admin_credentials (
  user_id            uuid PRIMARY KEY REFERENCES identity.users (id),
  email_hash         text        NOT NULL,            -- HMAC blind index (login lookup)
  email_enc          bytea       NOT NULL,            -- AES-256-GCM
  password_hash      text        NOT NULL,            -- Argon2id (self-describing PHC string)
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts    integer     NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  mfa_secret_enc     bytea,                           -- AES-256-GCM(TOTP secret); set at enrolment
  mfa_enabled_at     timestamptz,                     -- NULL until the first code is confirmed
  mfa_last_step      bigint,                          -- last accepted TOTP time-step (replay protection)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_credentials_email_hash_key ON identity.admin_credentials (email_hash);
CREATE TRIGGER admin_credentials_updated_at BEFORE UPDATE ON identity.admin_credentials
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Single-use recovery codes, stored only as keyed hashes.
CREATE TABLE identity.mfa_recovery_codes (
  id         uuid PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES identity.users (id),
  code_hash  text        NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON identity.mfa_recovery_codes (user_id) WHERE used_at IS NULL;
CREATE UNIQUE INDEX mfa_recovery_codes_hash_key ON identity.mfa_recovery_codes (user_id, code_hash);

-- Down Migration
