import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { UnitOfWork, uuidv7 } from '../../../shared-kernel';
import type { ProviderStatus } from '../domain/provider-status';
import type { ProviderDb } from './db-types';

export interface ProviderRow {
  id: string;
  owner_user_id: string;
  display_name: string;
  description: string | null;
  status: ProviderStatus;
  submitted_at: Date | null;
  decided_at: Date | null;
  decision_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface LocationInput {
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

const PROVIDER_COLUMNS = [
  'id',
  'owner_user_id',
  'display_name',
  'description',
  'status',
  'submitted_at',
  'decided_at',
  'decision_reason',
  'version',
  'created_at',
  'updated_at',
] as const;

@Injectable()
export class ProviderRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.db<ProviderDb>();
  }

  // --- providers ---------------------------------------------------------------------------------
  async insertProvider(row: { ownerUserId: string; displayName: string; description: string | null }): Promise<ProviderRow> {
    return this.db
      .insertInto('provider.providers')
      .values({
        id: uuidv7(),
        owner_user_id: row.ownerUserId,
        display_name: row.displayName,
        description: row.description,
        status: 'DRAFT',
        submitted_at: null,
        decided_at: null,
        decided_by: null,
        decision_reason: null,
        deleted_at: null,
      })
      .returning(PROVIDER_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  findProvider(id: string, opts: { forUpdate?: boolean } = {}): Promise<ProviderRow | undefined> {
    let q = this.db.selectFrom('provider.providers').select(PROVIDER_COLUMNS).where('id', '=', id).where('deleted_at', 'is', null);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  listProvidersByOwner(ownerUserId: string): Promise<ProviderRow[]> {
    return this.db
      .selectFrom('provider.providers')
      .select(PROVIDER_COLUMNS)
      .where('owner_user_id', '=', ownerUserId)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .execute();
  }

  /** Keyset pagination: uuidv7 ids are time-ordered, so `id` is a stable cursor. */
  listProviders(filter: { status?: ProviderStatus; afterId?: string; limit: number }): Promise<ProviderRow[]> {
    let q = this.db.selectFrom('provider.providers').select(PROVIDER_COLUMNS).where('deleted_at', 'is', null);
    if (filter.status) q = q.where('status', '=', filter.status);
    if (filter.afterId) q = q.where('id', '>', filter.afterId);
    return q.orderBy('id').limit(filter.limit).execute();
  }

  updateProfile(id: string, patch: { displayName?: string; description?: string | null }): Promise<ProviderRow | undefined> {
    const set: { display_name?: string; description?: string | null; version: ReturnType<typeof sql<number>> } = {
      version: sql<number>`version + 1`,
    };
    if (patch.displayName !== undefined) set.display_name = patch.displayName;
    if (patch.description !== undefined) set.description = patch.description;
    return this.db.updateTable('provider.providers').set(set).where('id', '=', id).returning(PROVIDER_COLUMNS).executeTakeFirst();
  }

  /** Compare-and-set on status: zero rows means someone else moved the provider first. */
  transitionStatus(
    id: string,
    expected: ProviderStatus,
    next: ProviderStatus,
    meta: { now: Date; decidedBy?: string; reason?: string | null; submitted?: boolean },
  ): Promise<ProviderRow | undefined> {
    return this.db
      .updateTable('provider.providers')
      .set({
        status: next,
        version: sql<number>`version + 1`,
        ...(meta.submitted ? { submitted_at: meta.now } : {}),
        ...(meta.decidedBy ? { decided_at: meta.now, decided_by: meta.decidedBy, decision_reason: meta.reason ?? null } : {}),
      })
      .where('id', '=', id)
      .where('status', '=', expected)
      .returning(PROVIDER_COLUMNS)
      .executeTakeFirst();
  }

  // --- locations -----------------------------------------------------------------------------------
  async listLocationIds(providerId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('provider.provider_locations')
      .select('id')
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((r) => r.id);
  }

  countActiveLocations(providerId: string): Promise<number> {
    return this.db
      .selectFrom('provider.provider_locations')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow()
      .then((r) => r.n);
  }

  private locationSelect() {
    return this.db
      .selectFrom('provider.provider_locations')
      .select([
        'id',
        'provider_id',
        'name',
        'address_line1',
        'address_line2',
        'city',
        'state',
        'postal_code',
        'country',
        'timezone',
        'status',
        'created_at',
        sql<number>`ST_Y(geog::geometry)`.as('latitude'),
        sql<number>`ST_X(geog::geometry)`.as('longitude'),
      ])
      .where('deleted_at', 'is', null);
  }

  listLocations(providerId: string) {
    return this.locationSelect().where('provider_id', '=', providerId).orderBy('id').execute();
  }

  findLocation(providerId: string, locationId: string) {
    return this.locationSelect().where('provider_id', '=', providerId).where('id', '=', locationId).executeTakeFirst();
  }

  async insertLocation(providerId: string, input: LocationInput): Promise<string> {
    const id = uuidv7();
    await this.db
      .insertInto('provider.provider_locations')
      .values({
        id,
        provider_id: providerId,
        name: input.name,
        address_line1: input.addressLine1,
        address_line2: input.addressLine2,
        city: input.city,
        state: input.state,
        postal_code: input.postalCode,
        country: input.country,
        // Coordinates are bound parameters, never string-concatenated into SQL.
        geog: sql`ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::geography`,
        timezone: input.timezone,
        deleted_at: null,
      })
      .execute();
    return id;
  }

  async updateLocation(providerId: string, locationId: string, patch: Partial<LocationInput> & { status?: 'ACTIVE' | 'INACTIVE' }) {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set['name'] = patch.name;
    if (patch.addressLine1 !== undefined) set['address_line1'] = patch.addressLine1;
    if (patch.addressLine2 !== undefined) set['address_line2'] = patch.addressLine2;
    if (patch.city !== undefined) set['city'] = patch.city;
    if (patch.state !== undefined) set['state'] = patch.state;
    if (patch.postalCode !== undefined) set['postal_code'] = patch.postalCode;
    if (patch.timezone !== undefined) set['timezone'] = patch.timezone;
    if (patch.status !== undefined) set['status'] = patch.status;
    if (patch.latitude !== undefined && patch.longitude !== undefined) {
      set['geog'] = sql`ST_SetSRID(ST_MakePoint(${patch.longitude}, ${patch.latitude}), 4326)::geography`;
    }
    if (Object.keys(set).length === 0) return false;
    const res = await this.db
      .updateTable('provider.provider_locations')
      .set(set)
      .where('id', '=', locationId)
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  async softDeleteLocation(providerId: string, locationId: string, now: Date): Promise<boolean> {
    const res = await this.db
      .updateTable('provider.provider_locations')
      .set({ deleted_at: now, status: 'INACTIVE' })
      .where('id', '=', locationId)
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  // --- directory reads for other modules (via ProviderDirectoryService only) -----------------------------
  findLocationWithProvider(locationId: string) {
    return this.db
      .selectFrom('provider.provider_locations as l')
      .innerJoin('provider.providers as p', 'p.id', 'l.provider_id')
      .select([
        'l.id as location_id',
        'l.provider_id',
        'l.timezone',
        'l.status as location_status',
        'l.name as location_name',
        'p.status as provider_status',
      ])
      .where('l.id', '=', locationId)
      .where('l.deleted_at', 'is', null)
      .where('p.deleted_at', 'is', null)
      .executeTakeFirst();
  }

  listActiveStaffResources(locationId: string) {
    return this.db
      .selectFrom('provider.bookable_resources')
      .select(['id', 'display_name'])
      .where('location_id', '=', locationId)
      .where('kind', '=', 'STAFF')
      .where('is_active', '=', true)
      .orderBy('id')
      .execute();
  }

  findResourceWithLocation(resourceId: string) {
    return this.db
      .selectFrom('provider.bookable_resources as r')
      .innerJoin('provider.provider_locations as l', 'l.id', 'r.location_id')
      .select(['r.id as resource_id', 'r.display_name', 'r.is_active', 'r.location_id', 'l.provider_id'])
      .where('r.id', '=', resourceId)
      .executeTakeFirst();
  }

  // --- staff & resources -----------------------------------------------------------------------------
  async insertResource(locationId: string, displayName: string): Promise<string> {
    const id = uuidv7();
    await this.db
      .insertInto('provider.bookable_resources')
      .values({ id, location_id: locationId, kind: 'STAFF', display_name: displayName })
      .execute();
    return id;
  }

  deactivateResource(resourceId: string) {
    return this.db.updateTable('provider.bookable_resources').set({ is_active: false }).where('id', '=', resourceId).execute();
  }

  renameResource(resourceId: string, displayName: string) {
    return this.db.updateTable('provider.bookable_resources').set({ display_name: displayName }).where('id', '=', resourceId).execute();
  }

  async insertStaff(row: {
    providerId: string;
    locationId: string;
    resourceId: string;
    displayName: string;
    staffRole: 'MANAGER' | 'STAFF';
    invitedPhoneHash: string | null;
  }): Promise<string> {
    const id = uuidv7();
    await this.db
      .insertInto('provider.provider_staff')
      .values({
        id,
        provider_id: row.providerId,
        location_id: row.locationId,
        user_id: null,
        invited_phone_hash: row.invitedPhoneHash,
        resource_id: row.resourceId,
        display_name: row.displayName,
        staff_role: row.staffRole,
        status: row.invitedPhoneHash ? 'INVITED' : 'ACTIVE',
        deleted_at: null,
      })
      .execute();
    return id;
  }

  private staffSelect() {
    return this.db
      .selectFrom('provider.provider_staff')
      .select(['id', 'provider_id', 'location_id', 'user_id', 'resource_id', 'display_name', 'staff_role', 'status', 'created_at'])
      .where('deleted_at', 'is', null);
  }

  listStaff(providerId: string, locationId?: string) {
    let q = this.staffSelect().where('provider_id', '=', providerId);
    if (locationId) q = q.where('location_id', '=', locationId);
    return q.orderBy('id').execute();
  }

  findStaff(providerId: string, staffId: string) {
    return this.staffSelect().where('provider_id', '=', providerId).where('id', '=', staffId).executeTakeFirst();
  }

  async updateStaff(staffId: string, patch: { displayName?: string; staffRole?: 'MANAGER' | 'STAFF' }) {
    const set: Record<string, unknown> = {};
    if (patch.displayName !== undefined) set['display_name'] = patch.displayName;
    if (patch.staffRole !== undefined) set['staff_role'] = patch.staffRole;
    if (Object.keys(set).length === 0) return;
    await this.db.updateTable('provider.provider_staff').set(set).where('id', '=', staffId).execute();
  }

  async softDeleteStaff(staffId: string, now: Date) {
    await this.db.updateTable('provider.provider_staff').set({ deleted_at: now, status: 'INACTIVE' }).where('id', '=', staffId).execute();
  }

  /** Pending invitations addressed to this phone blind-index, with enough context for the invitee to decide. */
  listInvitationsForPhone(phoneHash: string) {
    return this.db
      .selectFrom('provider.provider_staff as s')
      .innerJoin('provider.providers as p', 'p.id', 's.provider_id')
      .innerJoin('provider.provider_locations as l', 'l.id', 's.location_id')
      .select(['s.id', 's.staff_role', 's.display_name', 'p.display_name as provider_name', 'l.name as location_name', 's.created_at'])
      .where('s.invited_phone_hash', '=', phoneHash)
      .where('s.user_id', 'is', null)
      .where('s.status', '=', 'INVITED')
      .where('s.deleted_at', 'is', null)
      .where('p.deleted_at', 'is', null)
      .orderBy('s.id')
      .execute();
  }

  findInvitation(staffId: string, phoneHash: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db
      .selectFrom('provider.provider_staff')
      .select(['id', 'provider_id', 'location_id', 'staff_role', 'status', 'user_id'])
      .where('id', '=', staffId)
      .where('invited_phone_hash', '=', phoneHash)
      .where('user_id', 'is', null)
      .where('status', '=', 'INVITED')
      .where('deleted_at', 'is', null);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async acceptInvitation(staffId: string, userId: string) {
    await this.db
      .updateTable('provider.provider_staff')
      .set({ user_id: userId, status: 'ACTIVE', invited_phone_hash: null })
      .where('id', '=', staffId)
      .execute();
  }

  async declineInvitation(staffId: string, now: Date) {
    await this.db
      .updateTable('provider.provider_staff')
      .set({ status: 'INACTIVE', invited_phone_hash: null, deleted_at: now })
      .where('id', '=', staffId)
      .execute();
  }

  /**
   * Who should hear about a booking at a location: the business's owners, that location's managers, and the staff member the
   * booking is assigned to. Active accounts only. Returns user ids (never phone numbers).
   */
  async notificationRecipients(providerId: string, locationId: string, resourceId: string | null): Promise<string[]> {
    const rows = (
      await sql<{ user_id: string }>`
        SELECT p.owner_user_id AS user_id FROM provider.providers p WHERE p.id = ${providerId}
        UNION
        SELECT s.user_id FROM provider.provider_staff s
         WHERE s.provider_id = ${providerId} AND s.user_id IS NOT NULL AND s.deleted_at IS NULL AND s.status = 'ACTIVE'
           AND ((s.location_id = ${locationId} AND s.staff_role = 'MANAGER') OR (${resourceId}::uuid IS NOT NULL AND s.resource_id = ${resourceId}::uuid))
        UNION
        SELECT ra.user_id FROM identity.role_assignments ra JOIN identity.roles r ON r.id = ra.role_id
         WHERE r.code = 'PROVIDER_OWNER' AND ra.scope_type = 'PROVIDER' AND ra.scope_id = ${providerId} AND ra.revoked_at IS NULL`.execute(this.uow.db<unknown>())
    ).rows;
    return [...new Set(rows.map((r) => r.user_id))];
  }

  /** The business's owners (the people who should hear about money and verification). */
  async ownerRecipients(providerId: string): Promise<string[]> {
    const rows = (
      await sql<{ user_id: string }>`
        SELECT p.owner_user_id AS user_id FROM provider.providers p WHERE p.id = ${providerId}
        UNION
        SELECT ra.user_id FROM identity.role_assignments ra JOIN identity.roles r ON r.id = ra.role_id
         WHERE r.code = 'PROVIDER_OWNER' AND ra.scope_type = 'PROVIDER' AND ra.scope_id = ${providerId} AND ra.revoked_at IS NULL`.execute(this.uow.db<unknown>())
    ).rows;
    return [...new Set(rows.map((r) => r.user_id))];
  }
}
