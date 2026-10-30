import { Injectable } from '@nestjs/common';
import {
  Clock,
  ConflictError,
  NotFoundError,
  PG_EXCLUSION_VIOLATION,
  UnitOfWork,
  ValidationFailedError,
  pgErrorCode,
} from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { ProviderAccessService, ProviderDirectoryService } from '../../provider-management';
import { formatHHMM, parseHHMM, parseLocalDate } from '../domain/local-time';
import type { WeeklyRule } from '../domain/slot-engine';
import { AvailabilityRepository, PolicyRow, Scope } from '../infrastructure/availability.repository';
import { PolicyService } from './policy.service';

export interface WindowInput {
  weekday: number;
  start: string;
  end: string;
}

const MAX_BLOCK_MS = 24 * 3_600_000;

function toRules(kind: 'WORKING' | 'BREAK', items: WindowInput[], field: string): WeeklyRule[] {
  const rules = items.map((w, i) => {
    let startMin: number;
    let endMin: number;
    try {
      startMin = parseHHMM(w.start);
      endMin = w.end === '24:00' ? 1440 : parseHHMM(w.end);
    } catch (e) {
      throw new ValidationFailedError('Invalid time', { fields: { [`${field}[${i}]`]: [(e as Error).message] } });
    }
    if (endMin <= startMin) throw new ValidationFailedError('Invalid window', { fields: { [`${field}[${i}]`]: ['end must be after start'] } });
    return { kind, weekday: w.weekday, startMin, endMin } as WeeklyRule;
  });
  // Friendly overlap check (the database exclusion constraint is the real guarantee).
  for (const a of rules) {
    for (const b of rules) {
      if (a !== b && a.weekday === b.weekday && a.startMin < b.endMin && b.startMin < a.endMin) {
        throw new ValidationFailedError('Overlapping windows', { fields: { [field]: [`windows overlap on weekday ${a.weekday}`] } });
      }
    }
  }
  return rules;
}

const viewRules = (rules: WeeklyRule[]) => ({
  working: rules.filter((r) => r.kind === 'WORKING').map((r) => ({ weekday: r.weekday, start: formatHHMM(r.startMin), end: r.endMin === 1440 ? '24:00' : formatHHMM(r.endMin) })),
  breaks: rules.filter((r) => r.kind === 'BREAK').map((r) => ({ weekday: r.weekday, start: formatHHMM(r.startMin), end: r.endMin === 1440 ? '24:00' : formatHHMM(r.endMin) })),
});

export interface ExceptionInput {
  kind: 'CLOSED' | 'OPEN';
  startDate: string;
  endDate?: string;
  start?: string;
  end?: string;
  reason?: string;
}

/** Provider-side management of hours, leave, time blocks and booking-policy overrides. */
@Injectable()
export class SchedulingService {
  constructor(
    private readonly repo: AvailabilityRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly access: ProviderAccessService,
    private readonly directory: ProviderDirectoryService,
    private readonly policies: PolicyService,
    private readonly audit: AuditService,
  ) {}

  // --- scope resolution + authorization (IDOR-safe: foreign ids => 404) -----------------------------------------
  private async locationScope(userId: string, permission: string, providerId: string, locationId: string): Promise<Scope> {
    await this.access.require(userId, permission, providerId, locationId);
    const location = await this.directory.getLocation(locationId);
    if (!location || location.providerId !== providerId) throw new NotFoundError('Location');
    return { locationId };
  }

  private async staffScope(userId: string, permission: string, providerId: string, staffId: string): Promise<{ scope: Scope; resourceId: string; locationId: string }> {
    const staff = await this.directory.getStaffResource(providerId, staffId);
    if (!staff) {
      await this.access.requireRead(userId, providerId); // unrelated callers get the uniform 404 first
      throw new NotFoundError('Staff');
    }
    await this.access.require(userId, permission, providerId, staff.locationId);
    return { scope: { resourceId: staff.resourceId }, resourceId: staff.resourceId, locationId: staff.locationId };
  }

  // --- weekly hours -----------------------------------------------------------------------------------------------
  async getLocationHours(userId: string, providerId: string, locationId: string) {
    const scope = await this.locationScope(userId, 'schedule:read', providerId, locationId);
    return viewRules(await this.repo.listRules(scope));
  }

  async setLocationHours(userId: string, providerId: string, locationId: string, input: { working: WindowInput[]; breaks?: WindowInput[] }) {
    const scope = await this.locationScope(userId, 'schedule:manage', providerId, locationId);
    return this.replaceRules(userId, scope, input, 'location', locationId);
  }

  async getStaffSchedule(userId: string, providerId: string, staffId: string) {
    const { scope } = await this.staffScope(userId, 'schedule:read', providerId, staffId);
    return viewRules(await this.repo.listRules(scope));
  }

  async setStaffSchedule(userId: string, providerId: string, staffId: string, input: { working: WindowInput[]; breaks?: WindowInput[] }) {
    const { scope } = await this.staffScope(userId, 'schedule:manage', providerId, staffId);
    return this.replaceRules(userId, scope, input, 'staff', staffId);
  }

  private async replaceRules(userId: string, scope: Scope, input: { working: WindowInput[]; breaks?: WindowInput[] }, entityType: string, entityId: string) {
    const rules = [...toRules('WORKING', input.working, 'working'), ...toRules('BREAK', input.breaks ?? [], 'breaks')];
    return this.uow.run(async () => {
      const before = viewRules(await this.repo.listRules(scope));
      try {
        await this.repo.replaceRules(scope, rules);
      } catch (err) {
        if (pgErrorCode(err) === PG_EXCLUSION_VIOLATION) throw new ValidationFailedError('Overlapping windows');
        throw err;
      }
      const after = viewRules(rules);
      await this.audit.record({ actorType: 'USER', actorId: userId, action: `schedule.${entityType}_hours_replaced`, entityType, entityId, before, after });
      return after;
    });
  }

  // --- exceptions (holidays / leave / special openings) ----------------------------------------------------
  async listLocationExceptions(userId: string, providerId: string, locationId: string) {
    return this.listExceptions(await this.locationScope(userId, 'schedule:read', providerId, locationId));
  }

  async listStaffExceptions(userId: string, providerId: string, staffId: string) {
    return this.listExceptions((await this.staffScope(userId, 'schedule:read', providerId, staffId)).scope);
  }

  private async listExceptions(scope: Scope) {
    const today = this.clock.now().toISOString().slice(0, 10);
    return (await this.repo.listExceptions(scope, today)).map(viewException);
  }

  async addLocationException(userId: string, providerId: string, locationId: string, input: ExceptionInput) {
    return this.addException(userId, await this.locationScope(userId, 'schedule:manage', providerId, locationId), input, 'location', locationId);
  }

  async addStaffException(userId: string, providerId: string, staffId: string, input: ExceptionInput) {
    return this.addException(userId, (await this.staffScope(userId, 'schedule:manage', providerId, staffId)).scope, input, 'staff', staffId);
  }

  private async addException(userId: string, scope: Scope, input: ExceptionInput, entityType: string, entityId: string) {
    const fields: Record<string, string[]> = {};
    let startMin: number | null = null;
    let endMin: number | null = null;
    try {
      parseLocalDate(input.startDate);
    } catch (e) {
      fields['start_date'] = [(e as Error).message];
    }
    const endDate = input.endDate ?? input.startDate;
    try {
      parseLocalDate(endDate);
    } catch (e) {
      fields['end_date'] = [(e as Error).message];
    }
    if (!fields['start_date'] && !fields['end_date'] && endDate < input.startDate) fields['end_date'] = ['must not be before start_date'];
    if ((input.start === undefined) !== (input.end === undefined)) fields['start'] = ['start and end must be given together'];
    if (input.start !== undefined && input.end !== undefined) {
      try {
        startMin = parseHHMM(input.start);
        endMin = input.end === '24:00' ? 1440 : parseHHMM(input.end);
        if (endMin <= startMin) fields['end'] = ['must be after start'];
      } catch (e) {
        fields['start'] = [(e as Error).message];
      }
    }
    if (input.kind === 'OPEN' && input.start === undefined) fields['start'] = ['a special opening must say when (start and end)'];
    if (Object.keys(fields).length) throw new ValidationFailedError('Invalid exception', { fields });

    return this.uow.run(async () => {
      const id = await this.repo.insertException(scope, {
        kind: input.kind,
        startDate: input.startDate,
        endDate,
        startMin,
        endMin,
        reason: input.reason ?? null,
        createdBy: userId,
      });
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: `schedule.${entityType}_exception_added`,
        entityType,
        entityId,
        after: { exception_id: id, kind: input.kind, start_date: input.startDate, end_date: endDate },
      });
      return { id, kind: input.kind, start_date: input.startDate, end_date: endDate, start: input.start ?? null, end: input.end ?? null, reason: input.reason ?? null };
    });
  }

  async deleteLocationException(userId: string, providerId: string, locationId: string, exceptionId: string): Promise<void> {
    await this.deleteException(userId, await this.locationScope(userId, 'schedule:manage', providerId, locationId), exceptionId, 'location', locationId);
  }

  async deleteStaffException(userId: string, providerId: string, staffId: string, exceptionId: string): Promise<void> {
    await this.deleteException(userId, (await this.staffScope(userId, 'schedule:manage', providerId, staffId)).scope, exceptionId, 'staff', staffId);
  }

  private async deleteException(userId: string, scope: Scope, exceptionId: string, entityType: string, entityId: string): Promise<void> {
    await this.uow.run(async () => {
      if (!(await this.repo.deleteException(scope, exceptionId))) throw new NotFoundError('Exception');
      await this.audit.record({ actorType: 'USER', actorId: userId, action: `schedule.${entityType}_exception_removed`, entityType, entityId, metadata: { exception_id: exceptionId } });
    });
  }

  // --- time blocks (walk-ins, maintenance) --------------------------------------------------------------------
  async addBlock(userId: string, providerId: string, staffId: string, input: { startAt: string; endAt: string; reason?: string }) {
    const { resourceId } = await this.staffScope(userId, 'schedule:manage', providerId, staffId);
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    const fields: Record<string, string[]> = {};
    if (Number.isNaN(startAt.getTime())) fields['start_at'] = ['must be an ISO-8601 instant'];
    if (Number.isNaN(endAt.getTime())) fields['end_at'] = ['must be an ISO-8601 instant'];
    if (!fields['start_at'] && startAt.getTime() % 60_000 !== 0) fields['start_at'] = ['must be on a whole minute'];
    if (!fields['end_at'] && endAt.getTime() % 60_000 !== 0) fields['end_at'] = ['must be on a whole minute'];
    if (!fields['start_at'] && !fields['end_at']) {
      if (endAt <= startAt) fields['end_at'] = ['must be after start_at'];
      else if (endAt.getTime() - startAt.getTime() > MAX_BLOCK_MS) fields['end_at'] = ['a block may not exceed 24 hours'];
    }
    if (Object.keys(fields).length) throw new ValidationFailedError('Invalid block', { fields });

    return this.uow.run(async () => {
      let id: string;
      try {
        id = await this.repo.insertBlock({ resourceId, startAt, endAt, reason: input.reason ?? null, createdBy: userId });
      } catch (err) {
        // The EXCLUSION CONSTRAINT decided: something else already occupies this stylist at that time.
        if (pgErrorCode(err) === PG_EXCLUSION_VIOLATION) {
          throw new ConflictError('SLOT_UNAVAILABLE', 'That time overlaps an existing booking or block for this staff member');
        }
        throw err;
      }
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'schedule.block_added',
        entityType: 'provider_staff',
        entityId: staffId,
        after: { block_id: id, start_at: startAt.toISOString(), end_at: endAt.toISOString() },
      });
      return { id, start_at: startAt.toISOString(), end_at: endAt.toISOString(), reason: input.reason ?? null };
    });
  }

  async listBlocks(userId: string, providerId: string, staffId: string) {
    const { resourceId } = await this.staffScope(userId, 'schedule:read', providerId, staffId);
    const rows = await this.repo.listBlocks(resourceId, this.clock.now());
    return rows.map((b) => ({ id: b.id, start_at: b.start_at.toISOString(), end_at: b.end_at.toISOString(), reason: b.reason }));
  }

  async releaseBlock(userId: string, providerId: string, staffId: string, blockId: string): Promise<void> {
    const { resourceId } = await this.staffScope(userId, 'schedule:manage', providerId, staffId);
    await this.uow.run(async () => {
      if (!(await this.repo.releaseBlock(resourceId, blockId, this.clock.now()))) throw new NotFoundError('Block');
      await this.audit.record({ actorType: 'USER', actorId: userId, action: 'schedule.block_released', entityType: 'provider_staff', entityId: staffId, metadata: { block_id: blockId } });
    });
  }

  // --- booking policy overrides --------------------------------------------------------------------------------
  async getPolicy(userId: string, providerId: string) {
    await this.access.requireRead(userId, providerId);
    const effective = await this.policies.resolve(providerId);
    return { effective: toPolicyView(effective) };
  }

  /** Provider-level overrides. A field set to null clears the override (falls back to the platform default). */
  async setPolicy(userId: string, providerId: string, overrides: PolicyRow) {
    await this.access.require(userId, 'provider:update', providerId);
    return this.uow.run(async () => {
      const before = await this.policies.resolve(providerId);
      await this.repo.upsertProviderPolicy(providerId, overrides, userId);
      const after = await this.policies.resolve(providerId);
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'schedule.booking_policy_updated',
        entityType: 'provider',
        entityId: providerId,
        before: toPolicyView(before),
        after: toPolicyView(after),
      });
      return { effective: toPolicyView(after) };
    });
  }
}

const toPolicyView = (p: { slotGranularityMin: number; minLeadTimeMin: number; maxAdvanceDays: number; responseDeadlineMin: number; checkInWindowMin: number; noShowGraceMin: number; settlementHoldHours: number }) => ({
  slot_granularity_min: p.slotGranularityMin,
  min_lead_time_min: p.minLeadTimeMin,
  max_advance_days: p.maxAdvanceDays,
  response_deadline_min: p.responseDeadlineMin,
  check_in_window_min: p.checkInWindowMin,
  no_show_grace_min: p.noShowGraceMin,
  settlement_hold_hours: p.settlementHoldHours,
});

function viewException(e: { id: string; kind: 'CLOSED' | 'OPEN'; startDate: string; endDate: string; startMin: number | null; endMin: number | null; reason: string | null }) {
  return {
    id: e.id,
    kind: e.kind,
    start_date: e.startDate,
    end_date: e.endDate,
    start: e.startMin === null ? null : formatHHMM(e.startMin),
    end: e.endMin === null ? null : e.endMin === 1440 ? '24:00' : formatHHMM(e.endMin),
    reason: e.reason,
  };
}
