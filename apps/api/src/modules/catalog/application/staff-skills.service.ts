import { Injectable } from '@nestjs/common';
import { NotFoundError, UnitOfWork, ValidationFailedError } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { ProviderAccessService, ProviderDirectoryService } from '../../provider-management';
import { CatalogRepository } from '../infrastructure/catalog.repository';

/** Which services each stylist can perform (docs §H.2: availability honours skills). */
@Injectable()
export class StaffSkillsService {
  constructor(
    private readonly repo: CatalogRepository,
    private readonly uow: UnitOfWork,
    private readonly access: ProviderAccessService,
    private readonly directory: ProviderDirectoryService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string, providerId: string, staffId: string) {
    const staff = await this.directory.getStaffResource(providerId, staffId);
    if (!staff) {
      await this.access.requireRead(userId, providerId); // unrelated callers still get the uniform 404
      throw new NotFoundError('Staff');
    }
    await this.access.require(userId, 'staff:read', providerId, staff.locationId);
    const ids = await this.repo.listSkillServiceIds(staff.resourceId);
    return { staff_id: staffId, restricted: ids.length > 0, service_ids: ids };
  }

  /** Replaces the staff member's skill list. An empty list means "generalist: can do every service". */
  async set(userId: string, providerId: string, staffId: string, serviceIds: string[]) {
    await this.access.require(userId, 'staff:manage', providerId);
    const staff = await this.directory.getStaffResource(providerId, staffId);
    if (!staff) throw new NotFoundError('Staff');
    const unique = [...new Set(serviceIds)];

    return this.uow.run(async () => {
      // Every service must belong to THIS provider — a stylist can never be tied to another tenant's service.
      if ((await this.repo.countProviderServices(providerId, unique)) !== unique.length) {
        throw new ValidationFailedError('Unknown service', { fields: { service_ids: ['every id must be an existing service of this provider'] } });
      }
      const before = await this.repo.listSkillServiceIds(staff.resourceId);
      await this.repo.replaceSkills(staff.resourceId, unique);
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'catalog.staff_skills_updated',
        entityType: 'provider_staff',
        entityId: staffId,
        before: { service_ids: before },
        after: { service_ids: unique },
      });
      return { staff_id: staffId, restricted: unique.length > 0, service_ids: unique };
    });
  }
}
