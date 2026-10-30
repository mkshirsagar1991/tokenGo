import { Injectable } from '@nestjs/common';
import { Clock, DomainError, ForbiddenError, NotFoundError, isMfaVerified } from '../../../shared-kernel';
import { IdentityRepository, ScopeType } from '../infrastructure/identity.repository';

/** Where a permission is being exercised. Empty scope = platform-level only. */
export interface AuthzScope {
  providerId?: string;
  locationId?: string;
  /** Matches LOCATION-scoped grants at ANY of these locations ("allowed somewhere in this provider"). */
  locationIds?: string[];
}

/**
 * Central, server-side authorization (requirements §4: never rely on hidden buttons).
 * A permission is granted when the user holds an active role carrying it whose assignment scope covers
 * the target: PLATFORM covers everything, PROVIDER covers that provider and its locations, LOCATION
 * covers that single location.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly clock: Clock,
  ) {}

  can(userId: string, permission: string, scope: AuthzScope = {}): Promise<boolean> {
    // Privileged (requires_mfa) roles only count inside a session that passed MFA. Outside a request
    // (workers, CLIs) there is no MFA-verified human, so such roles confer nothing.
    return this.repo.hasPermission(userId, permission, scope, this.clock.now(), isMfaVerified());
  }

  /** True when the user holds a privileged role but this session has not completed MFA. */
  async isMissingMfa(userId: string): Promise<boolean> {
    return !isMfaVerified() && (await this.repo.holdsMfaRole(userId, this.clock.now()));
  }

  async require(userId: string, permission: string, scope: AuthzScope = {}): Promise<void> {
    if (!(await this.can(userId, permission, scope))) throw new ForbiddenError();
  }

  /**
   * Object-level access with IDOR hardening: callers with NO relationship to the provider get 404
   * (existence is not disclosed); callers who belong to it but lack the permission get 403.
   */
  async requireOnProvider(
    userId: string,
    permission: string,
    target: { providerId: string; locationId?: string; locationIds?: string[] },
    providerLocationIds: string[],
  ): Promise<void> {
    if (await this.can(userId, permission, target)) return;
    const related =
      (await this.can(userId, 'provider:read_any')) ||
      (await this.repo.hasAnyAccessToProvider(userId, target.providerId, providerLocationIds, this.clock.now()));
    throw related ? new ForbiddenError() : new NotFoundError('Provider');
  }

  hasAnyAccessToProvider(userId: string, providerId: string, locationIds: string[]): Promise<boolean> {
    return this.repo.hasAnyAccessToProvider(userId, providerId, locationIds, this.clock.now());
  }

  listPermissions(userId: string): Promise<string[]> {
    return this.repo.listPermissionsForUser(userId, this.clock.now(), isMfaVerified());
  }

  /** Idempotent. Validates the role exists and that the scope matches the role's declared scope type. */
  async grantRole(
    userId: string,
    roleCode: string,
    scope: { type: ScopeType; id?: string },
    grantedBy: string | null,
  ): Promise<boolean> {
    const role = await this.repo.findRoleByCode(roleCode);
    if (!role) throw new DomainError('ROLE_NOT_FOUND', `Unknown role ${roleCode}`, 400);
    if (role.scope_type !== scope.type) {
      throw new DomainError('ROLE_SCOPE_MISMATCH', `Role ${roleCode} is ${role.scope_type}-scoped`, 400);
    }
    if ((scope.type === 'PLATFORM') !== (scope.id === undefined)) {
      throw new DomainError('ROLE_SCOPE_INVALID', 'A scope id is required for provider/location roles only', 400);
    }
    return this.repo.grantRole({ userId, roleId: role.id, scopeType: scope.type, scopeId: scope.id ?? null, grantedBy });
  }

  async revokeRole(userId: string, roleCode: string, scope: { type: ScopeType; id?: string }): Promise<boolean> {
    const role = await this.repo.findRoleByCode(roleCode);
    if (!role) return false;
    return this.repo.revokeRole(userId, role.id, scope.type, scope.id ?? null, this.clock.now());
  }

  /** Blind-index of the authenticated user's phone — used by other modules to match staff invitations. */
  getPhoneHash(userId: string): Promise<string | undefined> {
    return this.repo.getPhoneHash(userId);
  }
}
