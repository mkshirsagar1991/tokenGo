import { Injectable } from '@nestjs/common';
import { AuthorizationService } from '../../identity-access';
import { NotFoundError } from '../../../shared-kernel';
import type { ProviderStatus } from '../domain/provider-status';
import { ProviderRepository } from '../infrastructure/provider.repository';

export interface ProviderSummary {
  id: string;
  status: ProviderStatus;
  ownerUserId: string;
}

/**
 * The provider-management FACADE other modules use for object-level authorization. It centralises
 * the IDOR rule (docs §M.1): a caller with no relationship to a provider gets 404 — identical to a
 * non-existent id — while a related caller lacking the specific permission gets 403.
 */
@Injectable()
export class ProviderAccessService {
  constructor(
    private readonly repo: ProviderRepository,
    private readonly authz: AuthorizationService,
  ) {}

  /** Require `permission` on the provider (and optionally one of its locations). Returns its summary. */
  async require(userId: string, permission: string, providerId: string, locationId?: string): Promise<ProviderSummary> {
    const provider = await this.repo.findProvider(providerId);
    if (!provider) throw new NotFoundError('Provider');
    const locationIds = await this.repo.listLocationIds(providerId);
    await this.authz.requireOnProvider(userId, permission, { providerId, locationId }, locationIds);
    return { id: provider.id, status: provider.status, ownerUserId: provider.owner_user_id };
  }

  /**
   * Like require(), but satisfied by the permission at provider scope OR at ANY of the provider's
   * locations — e.g. a stylist (location-scoped) may read the provider's service list.
   */
  async requireAtAnyScope(userId: string, permission: string, providerId: string): Promise<ProviderSummary> {
    const provider = await this.repo.findProvider(providerId);
    if (!provider) throw new NotFoundError('Provider');
    const locationIds = await this.repo.listLocationIds(providerId);
    await this.authz.requireOnProvider(userId, permission, { providerId, locationIds }, locationIds);
    return { id: provider.id, status: provider.status, ownerUserId: provider.owner_user_id };
  }

  /** Read access: platform `provider:read_any`, or ANY role bound to the provider/one of its locations. */
  async requireRead(userId: string, providerId: string): Promise<ProviderSummary> {
    const provider = await this.repo.findProvider(providerId);
    if (!provider) throw new NotFoundError('Provider');
    const allowed =
      (await this.authz.can(userId, 'provider:read_any')) ||
      (await this.authz.hasAnyAccessToProvider(userId, providerId, await this.repo.listLocationIds(providerId)));
    if (!allowed) throw new NotFoundError('Provider');
    return { id: provider.id, status: provider.status, ownerUserId: provider.owner_user_id };
  }
}
