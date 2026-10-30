import { Injectable } from '@nestjs/common';
import type { ProviderStatus } from '../domain/provider-status';
import { ProviderRepository } from '../infrastructure/provider.repository';

export interface LocationInfo {
  locationId: string;
  providerId: string;
  name: string;
  timezone: string;
  locationActive: boolean;
  providerStatus: ProviderStatus;
  /** Discoverable/bookable = provider APPROVED and location ACTIVE. */
  bookable: boolean;
}

export interface ResourceInfo {
  resourceId: string;
  displayName: string;
  locationId: string;
  providerId: string;
  active: boolean;
}

/**
 * Read-only directory other modules use to learn about locations and schedulable resources, instead of
 * touching the provider schema (docs §D.2). No authorization here: callers decide who may see what.
 */
@Injectable()
export class ProviderDirectoryService {
  constructor(private readonly repo: ProviderRepository) {}

  /** The business's owners (money and verification news goes to them). */
  ownerRecipients(providerId: string): Promise<string[]> {
    return this.repo.ownerRecipients(providerId);
  }

  /** User ids to notify about a booking (owners, the location's managers, the assigned staff member). */
  notificationRecipients(providerId: string, locationId: string, resourceId: string | null): Promise<string[]> {
    return this.repo.notificationRecipients(providerId, locationId, resourceId);
  }

  async providerExists(providerId: string): Promise<boolean> {
    return (await this.repo.findProvider(providerId)) !== undefined;
  }

  /** The provider's verification status, or undefined when it does not exist. */
  async getProviderStatus(providerId: string): Promise<ProviderStatus | undefined> {
    return (await this.repo.findProvider(providerId))?.status;
  }

  async getLocation(locationId: string): Promise<LocationInfo | undefined> {
    const row = await this.repo.findLocationWithProvider(locationId);
    if (!row) return undefined;
    return {
      locationId: row.location_id,
      providerId: row.provider_id,
      name: row.location_name,
      timezone: row.timezone,
      locationActive: row.location_status === 'ACTIVE',
      providerStatus: row.provider_status,
      bookable: row.location_status === 'ACTIVE' && row.provider_status === 'APPROVED',
    };
  }

  async listActiveResources(locationId: string): Promise<{ resourceId: string; displayName: string }[]> {
    return (await this.repo.listActiveStaffResources(locationId)).map((r) => ({ resourceId: r.id, displayName: r.display_name }));
  }

  async getResource(resourceId: string): Promise<ResourceInfo | undefined> {
    const r = await this.repo.findResourceWithLocation(resourceId);
    return r && { resourceId: r.resource_id, displayName: r.display_name, locationId: r.location_id, providerId: r.provider_id, active: r.is_active };
  }

  /** The schedulable resource behind a staff member, scoped to the provider (cross-tenant ids return undefined). */
  async getStaffResource(providerId: string, staffId: string): Promise<{ resourceId: string; locationId: string; displayName: string } | undefined> {
    const staff = await this.repo.findStaff(providerId, staffId);
    if (!staff || !staff.resource_id) return undefined;
    return { resourceId: staff.resource_id, locationId: staff.location_id, displayName: staff.display_name };
  }
}
