import type { Generated } from 'kysely';

/** Typed view of the tables owned by this module (schema `identity`). */
export interface UsersTable {
  id: string;
  phone_hash: string;
  phone_enc: Buffer;
  email_enc: Buffer | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'DELETED';
  locale: Generated<string>;
  last_login_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OtpChallengesTable {
  id: string;
  phone_hash: string;
  code_hash: string;
  purpose: Generated<string>;
  expires_at: Date;
  attempts: Generated<number>;
  max_attempts: number;
  consumed_at: Date | null;
  requested_ip_hash: string | null;
  device_id: string | null;
  created_at: Generated<Date>;
}

export interface AuthSessionsTable {
  id: string;
  user_id: string;
  device_id: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  last_used_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  mfa_verified_at: Date | null;
}

export interface AdminCredentialsTable {
  user_id: string;
  email_hash: string;
  email_enc: Buffer;
  password_hash: string;
  password_changed_at: Generated<Date>;
  failed_attempts: Generated<number>;
  locked_until: Date | null;
  mfa_secret_enc: Buffer | null;
  mfa_enabled_at: Date | null;
  /** bigint column — returned by `pg` as a string. */
  mfa_last_step: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MfaRecoveryCodesTable {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: Date | null;
  created_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: string;
  session_id: string;
  token_hash: string;
  issued_at: Generated<Date>;
  expires_at: Date;
  rotated_at: Date | null;
}

export interface PermissionsTable {
  code: string;
  description: string;
}

export interface RolesTable {
  id: string;
  code: string;
  name: string;
  scope_type: 'PLATFORM' | 'PROVIDER' | 'LOCATION';
  is_system: Generated<boolean>;
  /** Permissions of this role are only effective in sessions that completed MFA. */
  requires_mfa: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface RolePermissionsTable {
  role_id: string;
  permission_code: string;
}

export interface RoleAssignmentsTable {
  id: string;
  user_id: string;
  role_id: string;
  scope_type: 'PLATFORM' | 'PROVIDER' | 'LOCATION';
  scope_id: string | null;
  granted_by: string | null;
  created_at: Generated<Date>;
  valid_to: Date | null;
  revoked_at: Date | null;
}

export interface RateLimitCountersTable {
  key: string;
  window_start: Date;
  count: Generated<number>;
}

export interface IdentityDb {
  'identity.users': UsersTable;
  'identity.otp_challenges': OtpChallengesTable;
  'identity.auth_sessions': AuthSessionsTable;
  'identity.admin_credentials': AdminCredentialsTable;
  'identity.mfa_recovery_codes': MfaRecoveryCodesTable;
  'identity.refresh_tokens': RefreshTokensTable;
  'identity.permissions': PermissionsTable;
  'identity.roles': RolesTable;
  'identity.role_permissions': RolePermissionsTable;
  'identity.role_assignments': RoleAssignmentsTable;
  'platform.rate_limit_counters': RateLimitCountersTable;
}
