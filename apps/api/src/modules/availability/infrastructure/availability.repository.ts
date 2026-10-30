import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { UnitOfWork, uuidv7 } from '../../../shared-kernel';
import type { DateException, Interval, WeeklyRule } from '../domain/slot-engine';
import type { AvailabilityDb } from './db-types';

export type Scope = { locationId: string } | { resourceId: string };

export interface PolicyRow {
  slot_granularity_min: number | null;
  min_lead_time_min: number | null;
  max_advance_days: number | null;
  response_deadline_min: number | null;
  check_in_window_min: number | null;
  no_show_grace_min: number | null;
  settlement_hold_hours: number | null;
}

export interface ExceptionRow extends DateException {
  id: string;
  reason: string | null;
}

@Injectable()
export class AvailabilityRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.db<AvailabilityDb>();
  }

  // --- weekly rules -----------------------------------------------------------------------------------
  async listRules(scope: Scope): Promise<WeeklyRule[]> {
    let q = this.db.selectFrom('scheduling.availability_rules').select(['rule_type', 'weekday', 'start_min', 'end_min']);
    q = 'locationId' in scope ? q.where('location_id', '=', scope.locationId) : q.where('resource_id', '=', scope.resourceId);
    const rows = await q.orderBy('weekday').orderBy('start_min').execute();
    return rows.map((r) => ({ kind: r.rule_type, weekday: r.weekday, startMin: r.start_min, endMin: r.end_min }));
  }

  /** Bulk load for many resources (one query, not N). */
  async listRulesForResources(resourceIds: string[]): Promise<Map<string, WeeklyRule[]>> {
    const out = new Map<string, WeeklyRule[]>();
    if (resourceIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('scheduling.availability_rules')
      .select(['resource_id', 'rule_type', 'weekday', 'start_min', 'end_min'])
      .where('resource_id', 'in', resourceIds)
      .execute();
    for (const r of rows) {
      const list = out.get(r.resource_id!) ?? [];
      list.push({ kind: r.rule_type, weekday: r.weekday, startMin: r.start_min, endMin: r.end_min });
      out.set(r.resource_id!, list);
    }
    return out;
  }

  async replaceRules(scope: Scope, rules: WeeklyRule[]): Promise<void> {
    let del = this.db.deleteFrom('scheduling.availability_rules');
    del = 'locationId' in scope ? del.where('location_id', '=', scope.locationId) : del.where('resource_id', '=', scope.resourceId);
    await del.execute();
    if (rules.length === 0) return;
    await this.db
      .insertInto('scheduling.availability_rules')
      .values(
        rules.map((r) => ({
          id: uuidv7(),
          location_id: 'locationId' in scope ? scope.locationId : null,
          resource_id: 'resourceId' in scope ? scope.resourceId : null,
          rule_type: r.kind,
          weekday: r.weekday,
          start_min: r.startMin,
          end_min: r.endMin,
        })),
      )
      .execute();
  }

  // --- exceptions ----------------------------------------------------------------------------------------
  private exceptionSelect() {
    return this.db
      .selectFrom('scheduling.availability_exceptions')
      .select([
        'id',
        'kind',
        sql<string>`start_date::text`.as('start_date'),
        sql<string>`end_date::text`.as('end_date'),
        'start_min',
        'end_min',
        'reason',
      ]);
  }

  private toException(r: { id: string; kind: 'CLOSED' | 'OPEN'; start_date: string; end_date: string; start_min: number | null; end_min: number | null; reason: string | null }): ExceptionRow {
    return { id: r.id, kind: r.kind, startDate: r.start_date, endDate: r.end_date, startMin: r.start_min, endMin: r.end_min, reason: r.reason };
  }

  async listExceptions(scope: Scope, fromDate?: string): Promise<ExceptionRow[]> {
    let q = this.exceptionSelect();
    q = 'locationId' in scope ? q.where('location_id', '=', scope.locationId) : q.where('resource_id', '=', scope.resourceId);
    if (fromDate) q = q.where(sql<SqlBool>`end_date >= ${fromDate}::date`);
    return (await q.orderBy('start_date').orderBy('id').execute()).map((r) => this.toException(r));
  }

  async listExceptionsForResources(resourceIds: string[], fromDate: string): Promise<Map<string, ExceptionRow[]>> {
    const out = new Map<string, ExceptionRow[]>();
    if (resourceIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('scheduling.availability_exceptions')
      .select(['id', 'resource_id', 'kind', sql<string>`start_date::text`.as('start_date'), sql<string>`end_date::text`.as('end_date'), 'start_min', 'end_min', 'reason'])
      .where('resource_id', 'in', resourceIds)
      .where(sql<SqlBool>`end_date >= ${fromDate}::date`)
      .execute();
    for (const r of rows) {
      const list = out.get(r.resource_id!) ?? [];
      list.push(this.toException(r));
      out.set(r.resource_id!, list);
    }
    return out;
  }

  async insertException(scope: Scope, e: { kind: 'CLOSED' | 'OPEN'; startDate: string; endDate: string; startMin: number | null; endMin: number | null; reason: string | null; createdBy: string }): Promise<string> {
    const id = uuidv7();
    await this.db
      .insertInto('scheduling.availability_exceptions')
      .values({
        id,
        location_id: 'locationId' in scope ? scope.locationId : null,
        resource_id: 'resourceId' in scope ? scope.resourceId : null,
        kind: e.kind,
        start_date: e.startDate,
        end_date: e.endDate,
        start_min: e.startMin,
        end_min: e.endMin,
        reason: e.reason,
        created_by: e.createdBy,
      })
      .execute();
    return id;
  }

  async deleteException(scope: Scope, exceptionId: string): Promise<boolean> {
    let q = this.db.deleteFrom('scheduling.availability_exceptions').where('id', '=', exceptionId);
    q = 'locationId' in scope ? q.where('location_id', '=', scope.locationId) : q.where('resource_id', '=', scope.resourceId);
    const res = await q.executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  // --- reservations (blocks now, bookings later) ---------------------------------------------------------------
  /** ACTIVE reservations overlapping [from, to), as UTC-ms intervals keyed by resource. */
  async busyIntervals(resourceIds: string[], from: Date, to: Date): Promise<Map<string, Interval[]>> {
    const out = new Map<string, Interval[]>();
    if (resourceIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('scheduling.resource_reservations')
      .select(['resource_id', 'start_at', 'end_at'])
      .where('resource_id', 'in', resourceIds)
      .where('status', '=', 'ACTIVE')
      .where(sql<SqlBool>`occupied && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')`)
      .execute();
    for (const r of rows) {
      const list = out.get(r.resource_id) ?? [];
      list.push({ start: r.start_at.getTime(), end: r.end_at.getTime() });
      out.set(r.resource_id, list);
    }
    return out;
  }

  /**
   * Inserts a BLOCK. The database exclusion constraint (`resource_reservations_no_overlap`) is the final
   * arbiter: an overlap raises SQLSTATE 23P01, which the caller maps to SLOT_UNAVAILABLE.
   */
  async insertBlock(row: { resourceId: string; startAt: Date; endAt: Date; reason: string | null; createdBy: string }): Promise<string> {
    const id = uuidv7();
    await this.db
      .insertInto('scheduling.resource_reservations')
      .values({
        id,
        resource_id: row.resourceId,
        start_at: row.startAt,
        end_at: row.endAt,
        kind: 'BLOCK',
        booking_id: null,
        reason: row.reason,
        created_by: row.createdBy,
        released_at: null,
      })
      .execute();
    return id;
  }

  listBlocks(resourceId: string, from: Date) {
    return this.db
      .selectFrom('scheduling.resource_reservations')
      .select(['id', 'start_at', 'end_at', 'reason', 'kind'])
      .where('resource_id', '=', resourceId)
      .where('status', '=', 'ACTIVE')
      .where('kind', '=', 'BLOCK')
      .where('end_at', '>', from)
      .orderBy('start_at')
      .execute();
  }

  async releaseBlock(resourceId: string, blockId: string, now: Date): Promise<boolean> {
    const res = await this.db
      .updateTable('scheduling.resource_reservations')
      .set({ status: 'RELEASED', released_at: now })
      .where('id', '=', blockId)
      .where('resource_id', '=', resourceId)
      .where('kind', '=', 'BLOCK')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  // --- policy ---------------------------------------------------------------------------------------------------
  findPlatformPolicy(): Promise<PolicyRow | undefined> {
    return this.db
      .selectFrom('scheduling.booking_policies')
      .select(['slot_granularity_min', 'min_lead_time_min', 'max_advance_days', 'response_deadline_min', 'check_in_window_min', 'no_show_grace_min', 'settlement_hold_hours'])
      .where('scope_type', '=', 'PLATFORM')
      .executeTakeFirst();
  }

  findProviderPolicy(providerId: string): Promise<PolicyRow | undefined> {
    return this.db
      .selectFrom('scheduling.booking_policies')
      .select(['slot_granularity_min', 'min_lead_time_min', 'max_advance_days', 'response_deadline_min', 'check_in_window_min', 'no_show_grace_min', 'settlement_hold_hours'])
      .where('scope_type', '=', 'PROVIDER')
      .where('provider_id', '=', providerId)
      .executeTakeFirst();
  }

  /** Update-then-insert (the unique index is on an expression, so a plain ON CONFLICT target is awkward). */
  async upsertProviderPolicy(providerId: string, p: PolicyRow, updatedBy: string): Promise<void> {
    const updated = await this.db
      .updateTable('scheduling.booking_policies')
      .set({
        slot_granularity_min: p.slot_granularity_min,
        min_lead_time_min: p.min_lead_time_min,
        max_advance_days: p.max_advance_days,
        response_deadline_min: p.response_deadline_min,
        check_in_window_min: p.check_in_window_min,
        no_show_grace_min: p.no_show_grace_min,
        settlement_hold_hours: p.settlement_hold_hours,
        updated_by: updatedBy,
        updated_at: sql<Date>`now()`,
      })
      .where('scope_type', '=', 'PROVIDER')
      .where('provider_id', '=', providerId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return;
    await this.db
      .insertInto('scheduling.booking_policies')
      .values({
        id: uuidv7(),
        scope_type: 'PROVIDER',
        provider_id: providerId,
        slot_granularity_min: p.slot_granularity_min,
        min_lead_time_min: p.min_lead_time_min,
        max_advance_days: p.max_advance_days,
        response_deadline_min: p.response_deadline_min,
        check_in_window_min: p.check_in_window_min,
        no_show_grace_min: p.no_show_grace_min,
        settlement_hold_hours: p.settlement_hold_hours,
        updated_by: updatedBy,
      })
      .execute();
  }

  /**
   * Reserves a resource for a booking, or returns null if it is not free. Uses ON CONFLICT DO NOTHING, which
   * (verified on PostgreSQL) also covers the EXCLUSION constraint: a conflict yields no row and — unlike a
   * raised error — leaves the surrounding transaction usable, so a caller can try the next candidate.
   */
  async insertReservationIfFree(row: { resourceId: string; startAt: Date; endAt: Date; kind: 'BLOCK' | 'BOOKING'; bookingId: string | null; createdBy: string }): Promise<string | null> {
    const id = uuidv7();
    const inserted = await this.db
      .insertInto('scheduling.resource_reservations')
      .values({
        id,
        resource_id: row.resourceId,
        start_at: row.startAt,
        end_at: row.endAt,
        kind: row.kind,
        booking_id: row.bookingId,
        reason: null,
        created_by: row.createdBy,
        released_at: null,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return inserted ? inserted.id : null;
  }

  async releaseReservationById(reservationId: string, now: Date): Promise<boolean> {
    const res = await this.db
      .updateTable('scheduling.resource_reservations')
      .set({ status: 'RELEASED', released_at: now })
      .where('id', '=', reservationId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  /** Active reservations per resource in [from, to): used to spread "any stylist" bookings fairly. */
  async countActiveByResource(resourceIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (resourceIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('scheduling.resource_reservations')
      .select(['resource_id', sql<number>`count(*)::int`.as('n')])
      .where('resource_id', 'in', resourceIds)
      .where('status', '=', 'ACTIVE')
      .where('start_at', '>=', from)
      .where('start_at', '<', to)
      .groupBy('resource_id')
      .execute();
    for (const r of rows) out.set(r.resource_id, r.n);
    return out;
  }
}
