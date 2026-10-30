import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Actor, CurrentActor, Idempotent, ValidationFailedError } from '../../../shared-kernel';
import { BookingQueryService } from '../application/booking-query.service';
import { BookingService } from '../application/booking.service';
import type { BookingStatus } from '../domain/booking-state';

const uuid = () => new ParseUUIDPipe();
const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));
const STATUSES = ['REQUESTED', 'CONFIRMED', 'PROVIDER_REJECTED', 'EXPIRED', 'CUSTOMER_CANCELLED', 'PROVIDER_CANCELLED', 'NO_SHOW', 'CUSTOMER_ARRIVED', 'SERVICE_STARTED', 'SERVICE_COMPLETED', 'DISPUTED', 'CLOSED'] as const;
const REASONS = ['UNAVAILABLE', 'OVERBOOKED', 'STAFF_UNAVAILABLE', 'CLOSED_THAT_DAY', 'OTHER'] as const;

class CreateBookingDto {
  @IsUUID() location_id!: string;
  /** ONE service (the original form)... */
  @ValidateIf((o: CreateBookingDto) => o.service_ids === undefined) @IsUUID() service_id?: string;
  /** ...or SEVERAL for one visit (a haircut + a facial): priced, held and reserved together. */
  @ValidateIf((o: CreateBookingDto) => o.service_ids !== undefined) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(8) @IsUUID(undefined, { each: true }) service_ids?: string[];
  @IsISO8601({ strict: true }) start_at!: string;
  /** Omit for "any available stylist". */
  @IsOptional() @IsUUID() resource_id?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class ReasonDto {
  @IsIn(REASONS) reason_code!: (typeof REASONS)[number];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class CustomerCancelDto {
  @IsOptional() @IsString() @Matches(/^[A-Z_]{3,40}$/) reason_code?: string;
}

class ArrivalDto {
  @IsOptional() @Matches(/^\d{6}$/, { message: 'pin must be 6 digits' }) pin?: string;
  @IsOptional() @IsString() @MaxLength(300) qr_token?: string;
  /** Manager override when the customer cannot show a code (audited; needs a higher permission). */
  @IsOptional() @IsString() @MaxLength(300) manual_reason?: string;
}

class ListQuery {
  @IsOptional() @IsIn(STATUSES) status?: BookingStatus;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(50) limit?: number;
}

class ProviderListQuery extends ListQuery {
  @IsOptional() @IsUUID() location_id?: string;
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

@ApiTags('appointments')
@Controller({ path: 'appointments', version: '1' })
export class AppointmentController {
  constructor(
    private readonly bookings: BookingService,
    private readonly queries: BookingQueryService,
  ) {}

  /**
   * Request a booking. The server validates the slot, prices the service, reserves the funds and the time
   * slot in ONE transaction; the body carries no amounts, totals, commission or status.
   * `Idempotency-Key` is REQUIRED: retrying after a network failure returns the same booking.
   */
  @Post()
  @Idempotent({ required: true })
  async create(@CurrentActor() actor: Actor, @Body() dto: CreateBookingDto, @Headers('idempotency-key') key: string) {
    return {
      data: await this.bookings.create(actor.userId, {
        locationId: dto.location_id,
        serviceId: dto.service_id,
        serviceIds: dto.service_ids,
        startAt: dto.start_at,
        resourceId: dto.resource_id,
        note: dto.note,
        idempotencyKey: key,
      }),
    };
  }

  @Get()
  mine(@CurrentActor() actor: Actor, @Query() q: ListQuery) {
    return this.queries.listMine(actor.userId, { status: q.status, cursor: q.cursor, limit: q.limit ?? 20 });
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.queries.get(actor.userId, id) };
  }

  @Get(':id/events')
  async events(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.queries.events(actor.userId, id) };
  }

  /** Customer: the PIN + short-lived QR to show at the venue. */
  @Get(':id/arrival-code')
  async arrivalCode(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.bookings.getArrivalCode(actor.userId, id) };
  }

  // --- provider decisions ------------------------------------------------------------------------------------------
  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.bookings.approve(actor.userId, id) };
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: ReasonDto) {
    return { data: await this.bookings.reject(actor.userId, id, { reasonCode: dto.reason_code, note: dto.note }) };
  }

  @Post(':id/provider-cancel')
  @HttpCode(200)
  async providerCancel(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: ReasonDto) {
    return { data: await this.bookings.providerCancel(actor.userId, id, { reasonCode: dto.reason_code, note: dto.note }) };
  }

  @Post(':id/no-show')
  @HttpCode(200)
  async noShow(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.bookings.markNoShow(actor.userId, id) };
  }

  // --- customer ----------------------------------------------------------------------------------------------------
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: CustomerCancelDto) {
    return { data: await this.bookings.customerCancel(actor.userId, id, { reasonCode: dto.reason_code }) };
  }

  /** Customer confirms the service was delivered, so payment is released to the provider now. */
  @Post(':id/confirm-completion')
  @HttpCode(200)
  async confirmCompletion(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.bookings.confirmCompletion(actor.userId, id) };
  }

  // --- at the venue ---------------------------------------------------------------------------------------------------
  @Post(':id/verify-arrival')
  @HttpCode(200)
  async verifyArrival(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: ArrivalDto) {
    const given = [dto.pin, dto.qr_token, dto.manual_reason].filter((x) => x !== undefined).length;
    if (given !== 1) throw new ValidationFailedError('Provide exactly one of pin, qr_token or manual_reason');
    return { data: await this.bookings.verifyArrival(actor.userId, id, { pin: dto.pin, qrToken: dto.qr_token, manualReason: dto.manual_reason }) };
  }

  @Post(':id/start')
  @HttpCode(200)
  async start(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.bookings.startService(actor.userId, id) };
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.bookings.completeService(actor.userId, id) };
  }
}

@ApiTags('providers')
@Controller({ path: 'providers/:providerId/appointments', version: '1' })
export class ProviderAppointmentController {
  constructor(private readonly queries: BookingQueryService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Query() q: ProviderListQuery) {
    return this.queries.listForProvider(actor.userId, providerId, {
      locationId: q.location_id,
      status: q.status,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      cursor: q.cursor,
      limit: q.limit ?? 20,
    });
  }
}
