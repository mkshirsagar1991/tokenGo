import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { UnitOfWork, uuidv7 } from '../../../shared-kernel';
import type { BookingFlowType, CatalogDb } from './db-types';

const CATEGORY_COLUMNS = ['id', 'code', 'name', 'description', 'is_active', 'booking_flow_type', 'config', 'sort_order', 'version'] as const;
const SERVICE_TYPE_COLUMNS = ['id', 'category_id', 'code', 'name', 'description', 'attribute_schema', 'is_active', 'sort_order'] as const;
const PROVIDER_SERVICE_COLUMNS = [
  'id',
  'provider_id',
  'service_type_id',
  'name',
  'description',
  'price_minor',
  'currency',
  'duration_min',
  'buffer_min',
  'is_active',
  'attributes',
  'version',
] as const;

@Injectable()
export class CatalogRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.db<CatalogDb>();
  }

  // --- categories -----------------------------------------------------------------------------------
  listCategories(opts: { activeOnly: boolean }) {
    let q = this.db.selectFrom('catalog.categories').select(CATEGORY_COLUMNS);
    if (opts.activeOnly) q = q.where('is_active', '=', true);
    return q.orderBy('sort_order').orderBy('name').execute();
  }

  findCategoryByCode(code: string) {
    return this.db.selectFrom('catalog.categories').select(CATEGORY_COLUMNS).where('code', '=', code).executeTakeFirst();
  }

  findCategoryById(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('catalog.categories').select(CATEGORY_COLUMNS).where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  insertCategory(row: {
    code: string;
    name: string;
    description: string | null;
    isActive: boolean;
    bookingFlowType: BookingFlowType;
    config: Record<string, unknown>;
    sortOrder: number;
  }) {
    return this.db
      .insertInto('catalog.categories')
      .values({
        id: uuidv7(),
        code: row.code,
        name: row.name,
        description: row.description,
        is_active: row.isActive,
        booking_flow_type: row.bookingFlowType,
        config: JSON.stringify(row.config) as unknown as Record<string, unknown>,
        sort_order: row.sortOrder,
      })
      .returning(CATEGORY_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** `booking_flow_type` is intentionally NOT patchable: changing it under live providers would break their flows. */
  updateCategory(id: string, patch: { name?: string; description?: string | null; isActive?: boolean; config?: Record<string, unknown>; sortOrder?: number }) {
    const set: Record<string, unknown> = { version: sql<number>`version + 1` };
    if (patch.name !== undefined) set['name'] = patch.name;
    if (patch.description !== undefined) set['description'] = patch.description;
    if (patch.isActive !== undefined) set['is_active'] = patch.isActive;
    if (patch.config !== undefined) set['config'] = JSON.stringify(patch.config);
    if (patch.sortOrder !== undefined) set['sort_order'] = patch.sortOrder;
    return this.db.updateTable('catalog.categories').set(set).where('id', '=', id).returning(CATEGORY_COLUMNS).executeTakeFirstOrThrow();
  }

  // --- service types -----------------------------------------------------------------------------------
  listServiceTypes(categoryId: string, opts: { activeOnly: boolean }) {
    let q = this.db.selectFrom('catalog.service_types').select(SERVICE_TYPE_COLUMNS).where('category_id', '=', categoryId);
    if (opts.activeOnly) q = q.where('is_active', '=', true);
    return q.orderBy('sort_order').orderBy('name').execute();
  }

  findServiceTypeById(id: string) {
    return this.db.selectFrom('catalog.service_types').select(SERVICE_TYPE_COLUMNS).where('id', '=', id).executeTakeFirst();
  }

  insertServiceType(row: { categoryId: string; code: string; name: string; description: string | null; attributeSchema: Record<string, unknown>; sortOrder: number }) {
    return this.db
      .insertInto('catalog.service_types')
      .values({
        id: uuidv7(),
        category_id: row.categoryId,
        code: row.code,
        name: row.name,
        description: row.description,
        attribute_schema: JSON.stringify(row.attributeSchema) as unknown as Record<string, unknown>,
        sort_order: row.sortOrder,
      })
      .returning(SERVICE_TYPE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  updateServiceType(id: string, patch: { name?: string; description?: string | null; isActive?: boolean; sortOrder?: number }) {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set['name'] = patch.name;
    if (patch.description !== undefined) set['description'] = patch.description;
    if (patch.isActive !== undefined) set['is_active'] = patch.isActive;
    if (patch.sortOrder !== undefined) set['sort_order'] = patch.sortOrder;
    return this.db.updateTable('catalog.service_types').set(set).where('id', '=', id).returning(SERVICE_TYPE_COLUMNS).executeTakeFirstOrThrow();
  }

  // --- provider services ------------------------------------------------------------------------------------
  /** Joins the service type's category so callers can enforce "category must be enabled". */
  findServiceTypeWithCategory(serviceTypeId: string) {
    return this.db
      .selectFrom('catalog.service_types as st')
      .innerJoin('catalog.categories as c', 'c.id', 'st.category_id')
      .select(['st.id', 'st.is_active', 'c.id as category_id', 'c.is_active as category_active', 'c.booking_flow_type'])
      .where('st.id', '=', serviceTypeId)
      .executeTakeFirst();
  }

  insertProviderService(row: {
    providerId: string;
    serviceTypeId: string;
    name: string;
    description: string | null;
    priceMinor: bigint;
    currency: string;
    durationMin: number;
    bufferMin: number;
    attributes: Record<string, unknown>;
  }) {
    return this.db
      .insertInto('catalog.provider_services')
      .values({
        id: uuidv7(),
        provider_id: row.providerId,
        service_type_id: row.serviceTypeId,
        name: row.name,
        description: row.description,
        price_minor: row.priceMinor.toString(),
        currency: row.currency,
        duration_min: row.durationMin,
        buffer_min: row.bufferMin,
        attributes: JSON.stringify(row.attributes) as unknown as Record<string, unknown>,
        deleted_at: null,
      })
      .returning(PROVIDER_SERVICE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  listProviderServices(providerId: string) {
    return this.db
      .selectFrom('catalog.provider_services')
      .select(PROVIDER_SERVICE_COLUMNS)
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .execute();
  }

  findProviderService(providerId: string, serviceId: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db
      .selectFrom('catalog.provider_services')
      .select(PROVIDER_SERVICE_COLUMNS)
      .where('provider_id', '=', providerId)
      .where('id', '=', serviceId)
      .where('deleted_at', 'is', null);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** Bumps `version` ONLY when price/duration/buffer change — bookings snapshot that version (docs §G.3). */
  updateProviderService(
    providerId: string,
    serviceId: string,
    patch: { name?: string; description?: string | null; priceMinor?: bigint; durationMin?: number; bufferMin?: number; isActive?: boolean; attributes?: Record<string, unknown> },
    bumpVersion: boolean,
  ) {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set['name'] = patch.name;
    if (patch.description !== undefined) set['description'] = patch.description;
    if (patch.priceMinor !== undefined) set['price_minor'] = patch.priceMinor.toString();
    if (patch.durationMin !== undefined) set['duration_min'] = patch.durationMin;
    if (patch.bufferMin !== undefined) set['buffer_min'] = patch.bufferMin;
    if (patch.isActive !== undefined) set['is_active'] = patch.isActive;
    if (patch.attributes !== undefined) set['attributes'] = JSON.stringify(patch.attributes);
    if (bumpVersion) set['version'] = sql<number>`version + 1`;
    return this.db
      .updateTable('catalog.provider_services')
      .set(set)
      .where('provider_id', '=', providerId)
      .where('id', '=', serviceId)
      .where('deleted_at', 'is', null)
      .returning(PROVIDER_SERVICE_COLUMNS)
      .executeTakeFirst();
  }

  async softDeleteProviderService(providerId: string, serviceId: string, now: Date): Promise<boolean> {
    const res = await this.db
      .updateTable('catalog.provider_services')
      .set({ deleted_at: now, is_active: false })
      .where('provider_id', '=', providerId)
      .where('id', '=', serviceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  // --- bookable-service read + staff skills ----------------------------------------------------------------
  findBookableService(serviceId: string) {
    return this.db
      .selectFrom('catalog.provider_services as ps')
      .innerJoin('catalog.service_types as st', 'st.id', 'ps.service_type_id')
      .innerJoin('catalog.categories as c', 'c.id', 'st.category_id')
      .select([
        'ps.id',
        'ps.provider_id',
        'ps.name',
        'ps.price_minor',
        'ps.currency',
        'ps.duration_min',
        'ps.buffer_min',
        'ps.is_active',
        'ps.version',
        'ps.service_type_id',
        'st.is_active as service_type_active',
        'c.id as category_id',
        'c.is_active as category_active',
        'c.booking_flow_type',
      ])
      .where('ps.id', '=', serviceId)
      .where('ps.deleted_at', 'is', null)
      .executeTakeFirst();
  }

  async listSkillServiceIds(resourceId: string): Promise<string[]> {
    const rows = await this.db.selectFrom('catalog.resource_services').select('provider_service_id').where('resource_id', '=', resourceId).execute();
    return rows.map((r) => r.provider_service_id);
  }

  /** Resources (of those given) that have AT LEAST ONE skill row, with the services they are limited to. */
  async skillsByResource(resourceIds: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (resourceIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('catalog.resource_services')
      .select(['resource_id', 'provider_service_id'])
      .where('resource_id', 'in', resourceIds)
      .execute();
    for (const r of rows) {
      let set = out.get(r.resource_id);
      if (!set) out.set(r.resource_id, (set = new Set()));
      set.add(r.provider_service_id);
    }
    return out;
  }

  async countProviderServices(providerId: string, serviceIds: string[]): Promise<number> {
    if (serviceIds.length === 0) return 0;
    const row = await this.db
      .selectFrom('catalog.provider_services')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .where('id', 'in', serviceIds)
      .executeTakeFirstOrThrow();
    return row.n;
  }

  async replaceSkills(resourceId: string, serviceIds: string[]): Promise<void> {
    await this.db.deleteFrom('catalog.resource_services').where('resource_id', '=', resourceId).execute();
    if (serviceIds.length > 0) {
      await this.db
        .insertInto('catalog.resource_services')
        .values(serviceIds.map((id) => ({ resource_id: resourceId, provider_service_id: id })))
        .execute();
    }
  }

  // --- commission rules & cancellation policies (versioned configuration) ---------------------------------------
  async findCommissionRuleFor(at: Date, scopes: { providerServiceId: string; providerId: string; serviceTypeId: string; categoryId: string }) {
    const r = await sql<{ id: string; version: number; kind: 'PERCENT' | 'FIXED'; percent_bps: number | null; fixed_minor: string | null }>`
      SELECT id, version, kind, percent_bps, fixed_minor::text AS fixed_minor
        FROM catalog.commission_rules
       WHERE effective_from <= ${at} AND (effective_to IS NULL OR effective_to > ${at})
         AND (   (scope_type = 'PROVIDER_SERVICE' AND scope_id = ${scopes.providerServiceId}::uuid)
              OR (scope_type = 'PROVIDER'         AND scope_id = ${scopes.providerId}::uuid)
              OR (scope_type = 'SERVICE_TYPE'     AND scope_id = ${scopes.serviceTypeId}::uuid)
              OR (scope_type = 'CATEGORY'         AND scope_id = ${scopes.categoryId}::uuid)
              OR scope_type = 'PLATFORM')
       ORDER BY CASE scope_type WHEN 'PROVIDER_SERVICE' THEN 1 WHEN 'PROVIDER' THEN 2 WHEN 'SERVICE_TYPE' THEN 3 WHEN 'CATEGORY' THEN 4 ELSE 5 END
       LIMIT 1`.execute(this.db);
    return r.rows[0];
  }

  async findCancellationPolicyFor(at: Date, scopes: { providerId: string; categoryId: string }) {
    const r = await sql<{ id: string; name: string; version: number; no_show_refund_bps: number; provider_cancel_refund_bps: number }>`
      SELECT id, name, version, no_show_refund_bps, provider_cancel_refund_bps
        FROM catalog.cancellation_policies
       WHERE effective_from <= ${at} AND (effective_to IS NULL OR effective_to > ${at})
         AND (   (scope_type = 'PROVIDER' AND scope_id = ${scopes.providerId}::uuid)
              OR (scope_type = 'CATEGORY' AND scope_id = ${scopes.categoryId}::uuid)
              OR scope_type = 'PLATFORM')
       ORDER BY CASE scope_type WHEN 'PROVIDER' THEN 1 WHEN 'CATEGORY' THEN 2 ELSE 3 END
       LIMIT 1`.execute(this.db);
    const policy = r.rows[0];
    if (!policy) return undefined;
    const tiers = await this.db.selectFrom('catalog.cancellation_policy_tiers').select(['min_hours_before', 'refund_bps']).where('policy_id', '=', policy.id).orderBy('min_hours_before', 'desc').execute();
    return { ...policy, tiers };
  }

  listCommissionRules() {
    return this.db.selectFrom('catalog.commission_rules').selectAll().orderBy('scope_type').orderBy('scope_id').orderBy('effective_from', 'desc').execute();
  }

  listCancellationPolicies() {
    return this.db.selectFrom('catalog.cancellation_policies').selectAll().orderBy('scope_type').orderBy('scope_id').orderBy('effective_from', 'desc').execute();
  }

  /** The version of a scope that is open at (or after) `at` - the one a new version supersedes. */
  async findOpenCommissionRule(scopeType: string, scopeId: string | null, at: Date) {
    return this.db
      .selectFrom('catalog.commission_rules')
      .select(['id', 'version', 'effective_from', 'effective_to'])
      .where('scope_type', '=', scopeType as 'PLATFORM')
      .where((eb) => (scopeId ? eb('scope_id', '=', scopeId) : eb('scope_id', 'is', null)))
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
      .orderBy('effective_from', 'desc')
      .forUpdate()
      .executeTakeFirst();
  }

  closeCommissionRule(id: string, at: Date) {
    return this.db.updateTable('catalog.commission_rules').set({ effective_to: at }).where('id', '=', id).execute();
  }

  insertCommissionRule(row: { scopeType: 'PLATFORM' | 'CATEGORY' | 'SERVICE_TYPE' | 'PROVIDER' | 'PROVIDER_SERVICE'; scopeId: string | null; kind: 'PERCENT' | 'FIXED'; percentBps: number | null; fixedMinor: bigint | null; effectiveFrom: Date; version: number; createdBy: string }) {
    return this.db
      .insertInto('catalog.commission_rules')
      .values({
        id: uuidv7(),
        scope_type: row.scopeType,
        scope_id: row.scopeId,
        kind: row.kind,
        percent_bps: row.percentBps,
        fixed_minor: row.fixedMinor === null ? null : row.fixedMinor.toString(),
        effective_from: row.effectiveFrom,
        effective_to: null,
        version: row.version,
        created_by: row.createdBy,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
  }

  async findOpenCancellationPolicy(scopeType: string, scopeId: string | null, at: Date) {
    return this.db
      .selectFrom('catalog.cancellation_policies')
      .select(['id', 'version'])
      .where('scope_type', '=', scopeType as 'PLATFORM')
      .where((eb) => (scopeId ? eb('scope_id', '=', scopeId) : eb('scope_id', 'is', null)))
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
      .orderBy('effective_from', 'desc')
      .forUpdate()
      .executeTakeFirst();
  }

  closeCancellationPolicy(id: string, at: Date) {
    return this.db.updateTable('catalog.cancellation_policies').set({ effective_to: at }).where('id', '=', id).execute();
  }

  async insertCancellationPolicy(row: { name: string; scopeType: 'PLATFORM' | 'CATEGORY' | 'PROVIDER'; scopeId: string | null; noShowRefundBps: number; providerCancelRefundBps: number; effectiveFrom: Date; version: number; createdBy: string; tiers: { minHoursBefore: number; refundBps: number }[] }) {
    const id = uuidv7();
    await this.db
      .insertInto('catalog.cancellation_policies')
      .values({
        id,
        name: row.name,
        scope_type: row.scopeType,
        scope_id: row.scopeId,
        no_show_refund_bps: row.noShowRefundBps,
        provider_cancel_refund_bps: row.providerCancelRefundBps,
        effective_from: row.effectiveFrom,
        effective_to: null,
        version: row.version,
        created_by: row.createdBy,
      })
      .execute();
    await this.db.insertInto('catalog.cancellation_policy_tiers').values(row.tiers.map((t) => ({ policy_id: id, min_hours_before: t.minHoursBefore, refund_bps: t.refundBps }))).execute();
    return { id, version: row.version };
  }

  async categoryExists(id: string): Promise<boolean> {
    return (await this.db.selectFrom('catalog.categories').select('id').where('id', '=', id).executeTakeFirst()) !== undefined;
  }

  async serviceTypeExists(id: string): Promise<boolean> {
    return (await this.db.selectFrom('catalog.service_types').select('id').where('id', '=', id).executeTakeFirst()) !== undefined;
  }

  async providerServiceExists(id: string): Promise<boolean> {
    return (await this.db.selectFrom('catalog.provider_services').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst()) !== undefined;
  }
}
