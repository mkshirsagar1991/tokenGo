import { Injectable } from '@nestjs/common';
import { Clock, NotFoundError, UnitOfWork, ValidationFailedError } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { isValidTimeZone } from '../domain/timezone';
import { LocationInput, ProviderRepository } from '../infrastructure/provider.repository';
import { ProviderAccessService } from './provider-access.service';

type LocationRow = NonNullable<Awaited<ReturnType<ProviderRepository['findLocation']>>>;

export function toLocationView(l: LocationRow) {
  return {
    id: l.id,
    provider_id: l.provider_id,
    name: l.name,
    address_line1: l.address_line1,
    address_line2: l.address_line2,
    city: l.city,
    state: l.state,
    postal_code: l.postal_code,
    country: l.country,
    latitude: l.latitude,
    longitude: l.longitude,
    timezone: l.timezone,
    status: l.status,
  };
}

@Injectable()
export class LocationService {
  constructor(
    private readonly repo: ProviderRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly access: ProviderAccessService,
    private readonly audit: AuditService,
  ) {}

  private assertTimezone(tz: string | undefined): void {
    if (tz !== undefined && !isValidTimeZone(tz)) {
      throw new ValidationFailedError('Invalid timezone', { fields: { timezone: ['must be a valid IANA time zone, e.g. Asia/Kolkata'] } });
    }
  }

  async create(userId: string, providerId: string, input: LocationInput) {
    await this.access.require(userId, 'location:manage', providerId);
    this.assertTimezone(input.timezone);
    return this.uow.run(async () => {
      const id = await this.repo.insertLocation(providerId, input);
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.location_created',
        entityType: 'provider_location',
        entityId: id,
        // Business address is public listing data, but exact coordinates are kept out of the audit trail.
        after: { provider_id: providerId, name: input.name, city: input.city, timezone: input.timezone },
      });
      const created = await this.repo.findLocation(providerId, id);
      if (!created) throw new NotFoundError('Location');
      return toLocationView(created);
    });
  }

  async list(userId: string, providerId: string) {
    await this.access.requireRead(userId, providerId);
    return (await this.repo.listLocations(providerId)).map(toLocationView);
  }

  async update(userId: string, providerId: string, locationId: string, patch: Partial<LocationInput> & { status?: 'ACTIVE' | 'INACTIVE' }) {
    await this.access.require(userId, 'location:manage', providerId, locationId);
    this.assertTimezone(patch.timezone);
    if ((patch.latitude === undefined) !== (patch.longitude === undefined)) {
      throw new ValidationFailedError('latitude and longitude must be provided together');
    }
    return this.uow.run(async () => {
      if (!(await this.repo.findLocation(providerId, locationId))) throw new NotFoundError('Location');
      await this.repo.updateLocation(providerId, locationId, patch);
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.location_updated',
        entityType: 'provider_location',
        entityId: locationId,
        after: { provider_id: providerId, fields: Object.keys(patch) },
      });
      const updated = await this.repo.findLocation(providerId, locationId);
      if (!updated) throw new NotFoundError('Location');
      return toLocationView(updated);
    });
  }

  async remove(userId: string, providerId: string, locationId: string): Promise<void> {
    await this.access.require(userId, 'location:manage', providerId, locationId);
    await this.uow.run(async () => {
      if (!(await this.repo.softDeleteLocation(providerId, locationId, this.clock.now()))) throw new NotFoundError('Location');
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.location_deleted',
        entityType: 'provider_location',
        entityId: locationId,
        metadata: { provider_id: providerId },
      });
    });
  }
}
