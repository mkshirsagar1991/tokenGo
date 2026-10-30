import { Injectable } from '@nestjs/common';
import { Clock, Money, NotFoundError, ValidationFailedError } from '../../../shared-kernel';
import { CatalogReadService } from '../../catalog';
import { ProviderDirectoryService } from '../../provider-management';
import {
  addDays,
  formatHHMM,
  formatLocalDate,
  localToUtcMs,
  parseLocalDate,
  utcToLocal,
} from '../domain/local-time';
import { Schedule, Slot, computeSlots, isOpenAt } from '../domain/slot-engine';
import { AvailabilityRepository } from '../infrastructure/availability.repository';
import { EffectivePolicy, PolicyService } from './policy.service';

const MAX_DAYS = 14;

export interface SlotResult {
  locationId: string;
  timezone: string;
  /** The appointment as one block: for several services, the first one's id, all the names joined, the combined times. */
  service: { id: string; name: string; durationMin: number; bufferMin: number };
  /** The chosen services, in order, and what they cost together (public information, the same as the service list shows). */
  services: { id: string; name: string; durationMin: number; bufferMin: number; price: Money }[];
  price: Money;
  policy: EffectivePolicy;
  slots: (Slot & { localStart: string; resources: { id: string; displayName: string }[] })[];
}

/**
 * Availability queries (requirements §10). Loads the data, runs the pure engine, shapes the result.
 * The answer is ADVISORY: booking must re-validate transactionally against the exclusion constraint.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly repo: AvailabilityRepository,
    private readonly policies: PolicyService,
    private readonly directory: ProviderDirectoryService,
    private readonly catalog: CatalogReadService,
    private readonly clock: Clock,
  ) {}

  /** Give ONE service as `serviceId`, or several as `serviceIds` (one visit: they are done one after the other by the same person). */
  async getSlots(input: { locationId: string; serviceId?: string; serviceIds?: string[]; fromDate?: string; days?: number; resourceId?: string }): Promise<SlotResult> {
    const location = await this.directory.getLocation(input.locationId);
    // Not approved / inactive / deleted all look like "does not exist" to the public.
    if (!location || !location.bookable) throw new NotFoundError('Location');

    const bundle = await this.catalog.getBookableBundle(input.serviceIds ?? (input.serviceId ? [input.serviceId] : []));
    if (!bundle || bundle.providerId !== location.providerId || bundle.services.some((s) => !s.offerable)) throw new NotFoundError('Service');

    const days = input.days ?? 1;
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      throw new ValidationFailedError('Invalid range', { fields: { days: [`must be between 1 and ${MAX_DAYS}`] } });
    }

    const now = this.clock.now();
    const today = utcToLocal(now.getTime(), location.timezone).date;
    let fromDate = input.fromDate ?? formatLocalDate(today);
    try {
      parseLocalDate(fromDate);
    } catch {
      throw new ValidationFailedError('Invalid date', { fields: { date: ['must be a calendar date, YYYY-MM-DD'] } });
    }
    if (fromDate < formatLocalDate(today)) fromDate = formatLocalDate(today); // never offer the past

    const policy = await this.policies.resolve(location.providerId);

    // Candidate stylists: active at this location, able to perform the service, optionally a specific one.
    const active = await this.directory.listActiveResources(location.locationId);
    if (input.resourceId && !active.some((r) => r.resourceId === input.resourceId)) throw new NotFoundError('Staff');
    const eligibleIds = await this.catalog.filterResourcesBySkills(
      bundle.services.map((s) => s.id),
      active.map((r) => r.resourceId).filter((id) => !input.resourceId || id === input.resourceId),
    );
    const names = new Map(active.map((r) => [r.resourceId, r.displayName]));

    const rangeStart = new Date(localToUtcMs(parseLocalDate(fromDate), 0, location.timezone) - 86_400_000);
    const rangeEnd = new Date(localToUtcMs(addDays(parseLocalDate(fromDate), days), 0, location.timezone) + 86_400_000);
    const [locRules, locExceptions, rules, exceptions, busy] = await Promise.all([
      this.repo.listRules({ locationId: location.locationId }),
      this.repo.listExceptions({ locationId: location.locationId }, fromDate),
      this.repo.listRulesForResources(eligibleIds),
      this.repo.listExceptionsForResources(eligibleIds, fromDate),
      this.repo.busyIntervals(eligibleIds, rangeStart, rangeEnd),
    ]);

    const slots = computeSlots({
      timezone: location.timezone,
      fromDate,
      days,
      durationMin: bundle.durationMin,
      bufferMin: bundle.bufferMin,
      granularityMin: policy.slotGranularityMin,
      nowMs: now.getTime(),
      minLeadMin: policy.minLeadTimeMin,
      maxAdvanceDays: policy.maxAdvanceDays,
      location: { rules: locRules, exceptions: locExceptions },
      resources: eligibleIds.map((id) => ({
        resourceId: id,
        rules: rules.get(id) ?? [],
        exceptions: exceptions.get(id) ?? [],
        busy: busy.get(id) ?? [],
      })),
    });

    return {
      locationId: location.locationId,
      timezone: location.timezone,
      service: { id: bundle.services[0]!.id, name: bundle.name, durationMin: bundle.durationMin, bufferMin: bundle.bufferMin },
      services: bundle.services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, bufferMin: s.bufferMin, price: s.price })),
      price: bundle.price,
      policy,
      slots: slots.map((s) => {
        const local = utcToLocal(s.startMs, location.timezone);
        return {
          ...s,
          localStart: `${formatLocalDate(local.date)}T${formatHHMM(local.minuteOfDay)}`,
          resources: s.resourceIds.map((id) => ({ id, displayName: names.get(id) ?? '' })),
        };
      }),
    };
  }

  /** Earliest bookable start within `searchDays` (scanned in week-sized chunks), or null. */
  async nextAvailable(locationId: string, serviceId: string, searchDays = 14): Promise<Slot | null> {
    const location = await this.directory.getLocation(locationId);
    if (!location) return null;
    let from = utcToLocal(this.clock.now().getTime(), location.timezone).date;
    for (let scanned = 0; scanned < searchDays; scanned += 7) {
      const chunk = Math.min(7, searchDays - scanned);
      const res = await this.getSlots({ locationId, serviceId, fromDate: formatLocalDate(from), days: chunk });
      if (res.slots.length > 0) return res.slots[0] ?? null;
      from = addDays(from, chunk);
    }
    return null;
  }

  /** The "open now" badge: location hours/exceptions in the location's own timezone. */
  async isOpenNow(locationId: string): Promise<boolean> {
    const location = await this.directory.getLocation(locationId);
    if (!location) return false;
    const now = this.clock.now();
    const today = formatLocalDate(utcToLocal(now.getTime(), location.timezone).date);
    const schedule: Schedule = {
      rules: await this.repo.listRules({ locationId }),
      exceptions: await this.repo.listExceptions({ locationId }, today),
    };
    return isOpenAt(schedule, location.timezone, now.getTime());
  }

  /** Weekly opening hours for public profiles: `{ weekday, windows: [{start,end}] }` for Mon..Sun. */
  async weeklyHours(locationId: string) {
    const rules = await this.repo.listRules({ locationId });
    return [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      windows: rules
        .filter((r) => r.kind === 'WORKING' && r.weekday === weekday)
        .map((r) => ({ start: formatHHMM(r.startMin), end: r.endMin === 1440 ? '24:00' : formatHHMM(r.endMin) })),
      breaks: rules
        .filter((r) => r.kind === 'BREAK' && r.weekday === weekday)
        .map((r) => ({ start: formatHHMM(r.startMin), end: formatHHMM(r.endMin) })),
    }));
  }

  /**
   * AUTHORITATIVE re-check for booking: is exactly this start still offered right now, and by whom?
   * Uses the same engine as the public slot list, so lead time, advance window, hours, breaks, leave,
   * skills and existing reservations are all honoured. The reservation insert (exclusion constraint)
   * remains the final arbiter.
   */
  async findBookableSlot(input: { locationId: string; serviceId?: string; serviceIds?: string[]; startAt: Date; resourceId?: string }): Promise<{
    candidates: string[];
    timezone: string;
    policy: EffectivePolicy;
    dayStart: Date;
    dayEnd: Date;
  } | null> {
    const location = await this.directory.getLocation(input.locationId);
    if (!location || !location.bookable) throw new NotFoundError('Location');
    const local = utcToLocal(input.startAt.getTime(), location.timezone).date;
    const result = await this.getSlots({ locationId: input.locationId, serviceId: input.serviceId, serviceIds: input.serviceIds, fromDate: formatLocalDate(local), days: 1, resourceId: input.resourceId });
    const slot = result.slots.find((s) => s.startMs === input.startAt.getTime());
    if (!slot) return null;
    return {
      candidates: slot.resourceIds,
      timezone: location.timezone,
      policy: result.policy,
      dayStart: new Date(localToUtcMs(local, 0, location.timezone)),
      dayEnd: new Date(localToUtcMs(addDays(local, 1), 0, location.timezone)),
    };
  }

  // ===== reservations: the facade the booking module uses ======================================================
  /**
   * Tries the candidates in order (least-loaded that day first) and reserves the first free one for
   * [startAt, startAt + duration + buffer). Returns null when every candidate is taken. Call INSIDE the
   * booking transaction: the database exclusion constraint is the final arbiter, never the earlier slot list.
   */
  async reserveFirstFree(input: {
    candidates: string[];
    startAt: Date;
    durationMin: number;
    bufferMin: number;
    bookingId: string;
    createdBy: string;
    dayStart: Date;
    dayEnd: Date;
  }): Promise<{ reservationId: string; resourceId: string; occupiedUntil: Date } | null> {
    const load = await this.repo.countActiveByResource(input.candidates, input.dayStart, input.dayEnd);
    const ordered = [...input.candidates].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || (a < b ? -1 : 1));
    const occupiedUntil = new Date(input.startAt.getTime() + (input.durationMin + input.bufferMin) * 60_000);
    for (const resourceId of ordered) {
      const reservationId = await this.repo.insertReservationIfFree({
        resourceId,
        startAt: input.startAt,
        endAt: occupiedUntil,
        kind: 'BOOKING',
        bookingId: input.bookingId,
        createdBy: input.createdBy,
      });
      if (reservationId) return { reservationId, resourceId, occupiedUntil };
    }
    return null;
  }

  async releaseReservation(reservationId: string): Promise<boolean> {
    return this.repo.releaseReservationById(reservationId, this.clock.now());
  }
}
