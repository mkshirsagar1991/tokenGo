export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'DELETED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface RoleAssignment {
  code: string;
  scope_type: 'PLATFORM' | 'PROVIDER' | 'LOCATION';
  scope_id: string | null;
}

export interface UserView {
  id: string;
  phone_masked: string;
  status: UserStatus;
  is_admin_account: boolean;
  roles: RoleAssignment[];
  created_at: string;
  last_login_at: string | null;
  deletion_scheduled_for: string | null;
  /** Only on the detail endpoint. */
  active_sessions?: number;
}

export interface RoleDefinition {
  code: string;
  name: string;
  scope_type: 'PLATFORM' | 'PROVIDER' | 'LOCATION';
  requires_mfa: boolean;
  permissions: string[];
}

/** Platform staff roles (everything PLATFORM-scoped except plain CUSTOMER) need an administrator account with MFA. */
export const isStaffRole = (r: Pick<RoleDefinition, 'code' | 'scope_type'>): boolean => r.scope_type === 'PLATFORM' && r.code !== 'CUSTOMER';

export const SCOPE_HELP: Record<RoleAssignment['scope_type'], string> = {
  PLATFORM: 'Applies everywhere on the platform',
  PROVIDER: 'Applies to one provider (and its locations)',
  LOCATION: 'Applies to one location only',
};
