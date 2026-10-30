import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Idempotent } from '../../../shared-kernel';
import { Actor, CurrentActor, Public } from '../../identity-access';
import { AvailabilityService } from '../application/availability.service';
import { SchedulingService } from '../application/scheduling.service';
import { BlockDto, ExceptionDto, PolicyDto, SetHoursDto, SlotsQueryDto } from './availability.dto';

const uuid = () => new ParseUUIDPipe();

/** Public: customers browse availability before logging in. The result is advisory (see ADR / proposal §H.2). */
@ApiTags('availability')
@Controller({ path: 'availability', version: '1' })
export class PublicAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Public()
  @Get('slots')
  async slots(@Query() q: SlotsQueryDto) {
    const r = await this.availability.getSlots({
      locationId: q.location_id,
      serviceId: q.service_id,
      serviceIds: q.service_ids,
      fromDate: q.date,
      days: q.days,
      resourceId: q.resource_id,
    });
    return {
      data: {
        location_id: r.locationId,
        timezone: r.timezone,
        // `service` is the whole visit as one block (several services: names joined, times added). `services` lists them one by one.
        service: { id: r.service.id, name: r.service.name, duration_min: r.service.durationMin },
        services: r.services.map((s) => ({ id: s.id, name: s.name, duration_min: s.durationMin, price: s.price.toJSON() })),
        total: { duration_min: r.service.durationMin, price: r.price.toJSON() },
        slots: r.slots.map((s) => ({
          start_at: new Date(s.startMs).toISOString(),
          end_at: new Date(s.endMs).toISOString(),
          local_start: s.localStart,
          resources: s.resources.map((x) => ({ id: x.id, display_name: x.displayName })),
        })),
      },
      meta: { advisory: true },
    };
  }
}

@ApiTags('providers')
@Controller({ path: 'providers/:providerId', version: '1' })
export class ProviderScheduleController {
  constructor(private readonly scheduling: SchedulingService) {}

  // --- location hours ----------------------------------------------------------------------------------------
  @Get('locations/:locationId/hours')
  async getHours(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('locationId', uuid()) l: string) {
    return { data: await this.scheduling.getLocationHours(a.userId, p, l) };
  }

  /** Replaces the whole weekly pattern. */
  @Put('locations/:locationId/hours')
  async setHours(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('locationId', uuid()) l: string, @Body() dto: SetHoursDto) {
    return { data: await this.scheduling.setLocationHours(a.userId, p, l, dto) };
  }

  @Get('locations/:locationId/exceptions')
  async listLocationExceptions(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('locationId', uuid()) l: string) {
    return { data: await this.scheduling.listLocationExceptions(a.userId, p, l) };
  }

  @Post('locations/:locationId/exceptions')
  @Idempotent()
  async addLocationException(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('locationId', uuid()) l: string, @Body() dto: ExceptionDto) {
    return { data: await this.scheduling.addLocationException(a.userId, p, l, toExceptionInput(dto)) };
  }

  @Delete('locations/:locationId/exceptions/:exceptionId')
  @HttpCode(204)
  async deleteLocationException(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('locationId', uuid()) l: string, @Param('exceptionId', uuid()) e: string): Promise<void> {
    await this.scheduling.deleteLocationException(a.userId, p, l, e);
  }

  // --- staff schedule, leave and time blocks -----------------------------------------------------------------
  @Get('staff/:staffId/schedule')
  async getSchedule(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('staffId', uuid()) s: string) {
    return { data: await this.scheduling.getStaffSchedule(a.userId, p, s) };
  }

  @Put('staff/:staffId/schedule')
  async setSchedule(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('staffId', uuid()) s: string, @Body() dto: SetHoursDto) {
    return { data: await this.scheduling.setStaffSchedule(a.userId, p, s, dto) };
  }

  @Get('staff/:staffId/exceptions')
  async listStaffExceptions(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('staffId', uuid()) s: string) {
    return { data: await this.scheduling.listStaffExceptions(a.userId, p, s) };
  }

  @Post('staff/:staffId/exceptions')
  @Idempotent()
  async addStaffException(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('staffId', uuid()) s: string, @Body() dto: ExceptionDto) {
    return { data: await this.scheduling.addStaffException(a.userId, p, s, toExceptionInput(dto)) };
  }

  @Delete('staff/:staffId/exceptions/:exceptionId')
  @HttpCode(204)
  async deleteStaffException(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('staffId', uuid()) s: string, @Param('exceptionId', uuid()) e: string): Promise<void> {
    await this.scheduling.deleteStaffException(a.userId, p, s, e);
  }

  @Get('staff/:staffId/blocks')
  async listBlocks(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('staffId', uuid()) s: string) {
    return { data: await this.scheduling.listBlocks(a.userId, p, s) };
  }

  /** Walk-ins / maintenance: occupies the stylist exactly like a booking (409 SLOT_UNAVAILABLE on overlap). */
  @Post('staff/:staffId/blocks')
  @Idempotent()
  async addBlock(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('staffId', uuid()) s: string, @Body() dto: BlockDto) {
    return { data: await this.scheduling.addBlock(a.userId, p, s, { startAt: dto.start_at, endAt: dto.end_at, reason: dto.reason }) };
  }

  @Delete('staff/:staffId/blocks/:blockId')
  @HttpCode(204)
  async releaseBlock(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Param('staffId', uuid()) s: string, @Param('blockId', uuid()) b: string): Promise<void> {
    await this.scheduling.releaseBlock(a.userId, p, s, b);
  }

  // --- booking policy --------------------------------------------------------------------------------------------
  @Get('booking-policy')
  async getPolicy(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string) {
    return { data: await this.scheduling.getPolicy(a.userId, p) };
  }

  /** Provider-level overrides; a field set to null reverts to the platform default. */
  @Put('booking-policy')
  async setPolicy(@CurrentActor() a: Actor, @Param('providerId', uuid()) p: string, @Body() dto: PolicyDto) {
    return {
      data: await this.scheduling.setPolicy(a.userId, p, {
        slot_granularity_min: dto.slot_granularity_min ?? null,
        min_lead_time_min: dto.min_lead_time_min ?? null,
        max_advance_days: dto.max_advance_days ?? null,
        response_deadline_min: dto.response_deadline_min ?? null,
        check_in_window_min: dto.check_in_window_min ?? null,
        no_show_grace_min: dto.no_show_grace_min ?? null,
        settlement_hold_hours: dto.settlement_hold_hours ?? null,
      }),
    };
  }
}

function toExceptionInput(dto: ExceptionDto) {
  return { kind: dto.kind, startDate: dto.start_date, endDate: dto.end_date, start: dto.start, end: dto.end, reason: dto.reason };
}
