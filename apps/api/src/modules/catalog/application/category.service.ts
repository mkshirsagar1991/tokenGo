import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, PG_UNIQUE_VIOLATION, UnitOfWork, pgErrorCode } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import type { BookingFlowType } from '../infrastructure/db-types';
import { CatalogRepository } from '../infrastructure/catalog.repository';

type CategoryRow = Awaited<ReturnType<CatalogRepository['insertCategory']>>;
type ServiceTypeRow = Awaited<ReturnType<CatalogRepository['insertServiceType']>>;

export const toCategoryView = (c: CategoryRow) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  description: c.description,
  is_active: c.is_active,
  booking_flow_type: c.booking_flow_type,
  config: c.config,
  sort_order: c.sort_order,
  version: c.version,
});

export const toServiceTypeView = (s: ServiceTypeRow) => ({
  id: s.id,
  category_id: s.category_id,
  code: s.code,
  name: s.name,
  description: s.description,
  attribute_schema: s.attribute_schema,
  is_active: s.is_active,
  sort_order: s.sort_order,
});

/** Public (customer-facing) views hide administrative detail. */
const toPublicCategory = (c: CategoryRow) => ({ id: c.id, code: c.code, name: c.name, description: c.description, booking_flow_type: c.booking_flow_type });
const toPublicServiceType = (s: ServiceTypeRow) => ({ id: s.id, code: s.code, name: s.name, description: s.description });

@Injectable()
export class CategoryService {
  constructor(
    private readonly repo: CatalogRepository,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  // --- public ---------------------------------------------------------------------------------------------
  async listPublicCategories() {
    return (await this.repo.listCategories({ activeOnly: true })).map(toPublicCategory);
  }

  async listPublicServiceTypes(categoryCode: string) {
    const category = await this.repo.findCategoryByCode(categoryCode);
    // A disabled category is indistinguishable from a non-existent one for customers.
    if (!category || !category.is_active) throw new NotFoundError('Category');
    return (await this.repo.listServiceTypes(category.id, { activeOnly: true })).map(toPublicServiceType);
  }

  // --- admin -------------------------------------------------------------------------------------------------
  async adminList() {
    return (await this.repo.listCategories({ activeOnly: false })).map(toCategoryView);
  }

  async adminListServiceTypes(categoryId: string) {
    if (!(await this.repo.findCategoryById(categoryId))) throw new NotFoundError('Category');
    return (await this.repo.listServiceTypes(categoryId, { activeOnly: false })).map(toServiceTypeView);
  }

  async create(
    adminId: string,
    input: { code: string; name: string; description: string | null; isActive: boolean; bookingFlowType: BookingFlowType; config: Record<string, unknown>; sortOrder: number },
  ) {
    return this.uow.run(async () => {
      try {
        const created = await this.repo.insertCategory(input);
        await this.audit.record({
          actorType: 'USER',
          actorId: adminId,
          action: 'catalog.category_created',
          entityType: 'category',
          entityId: created.id,
          after: toCategoryView(created),
        });
        return toCategoryView(created);
      } catch (err) {
        if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ConflictError('CATEGORY_CODE_TAKEN', `Category code "${input.code}" already exists`);
        throw err;
      }
    });
  }

  async update(
    adminId: string,
    categoryId: string,
    patch: { name?: string; description?: string | null; isActive?: boolean; config?: Record<string, unknown>; sortOrder?: number },
    expectedVersion?: number,
  ) {
    return this.uow.run(async () => {
      const before = await this.repo.findCategoryById(categoryId, { forUpdate: true });
      if (!before) throw new NotFoundError('Category');
      if (expectedVersion !== undefined && expectedVersion !== before.version) {
        throw new ConflictError('CONCURRENT_MODIFICATION', 'The category was changed by someone else; reload and retry', {
          current_version: before.version,
        });
      }
      const after = await this.repo.updateCategory(categoryId, patch);
      await this.audit.record({
        actorType: 'USER',
        actorId: adminId,
        action: before.is_active !== after.is_active ? (after.is_active ? 'catalog.category_enabled' : 'catalog.category_disabled') : 'catalog.category_updated',
        entityType: 'category',
        entityId: categoryId,
        before: toCategoryView(before as CategoryRow),
        after: toCategoryView(after),
      });
      return toCategoryView(after);
    });
  }

  async createServiceType(
    adminId: string,
    categoryId: string,
    input: { code: string; name: string; description: string | null; attributeSchema: Record<string, unknown>; sortOrder: number },
  ) {
    return this.uow.run(async () => {
      if (!(await this.repo.findCategoryById(categoryId))) throw new NotFoundError('Category');
      try {
        const created = await this.repo.insertServiceType({ categoryId, ...input });
        await this.audit.record({
          actorType: 'USER',
          actorId: adminId,
          action: 'catalog.service_type_created',
          entityType: 'service_type',
          entityId: created.id,
          after: toServiceTypeView(created),
        });
        return toServiceTypeView(created);
      } catch (err) {
        if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ConflictError('SERVICE_TYPE_CODE_TAKEN', `Service type code "${input.code}" already exists in this category`);
        throw err;
      }
    });
  }

  async updateServiceType(
    adminId: string,
    serviceTypeId: string,
    patch: { name?: string; description?: string | null; isActive?: boolean; sortOrder?: number },
  ) {
    return this.uow.run(async () => {
      const before = await this.repo.findServiceTypeById(serviceTypeId);
      if (!before) throw new NotFoundError('Service type');
      const after = await this.repo.updateServiceType(serviceTypeId, patch);
      await this.audit.record({
        actorType: 'USER',
        actorId: adminId,
        action: 'catalog.service_type_updated',
        entityType: 'service_type',
        entityId: serviceTypeId,
        before: toServiceTypeView(before as ServiceTypeRow),
        after: toServiceTypeView(after),
      });
      return toServiceTypeView(after);
    });
  }
}
