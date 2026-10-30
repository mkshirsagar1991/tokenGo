import { Injectable } from '@nestjs/common';
import { localDateTime } from '../../availability';
import { ProviderDirectoryService } from '../../provider-management';
import { BookingRepository } from '../infrastructure/booking.repository';
import type { BookingStatus } from '../domain/booking-state';

/** The few facts other modules (notifications, reviews, support) need about a booking. No authorization: callers decide who may see it. */
export interface BookingSummary {
  id: string;
  reference: string;
  status: BookingStatus;
  customerId: string;
  providerId: string;
  locationId: string;
  locationName: string | null;
  resourceId: string;
  serviceName: string;
  startAt: Date;
  /** Wall-clock time AT THE LOCATION, e.g. "2026-10-08T10:00". */
  localStart: string;
  timezone: string;
  closedAt: Date | null;
  priceMinor: bigint;
  /** What was actually held for the booking (the most a dispute can ever move). */
  grossMinor: bigint;
  currency: string;
}

@Injectable()
export class BookingSummaryService {
  constructor(
    private readonly repo: BookingRepository,
    private readonly directory: ProviderDirectoryService,
  ) {}

  async get(bookingId: string): Promise<BookingSummary | undefined> {
    const b = await this.repo.findById(bookingId);
    if (!b) return undefined;
    const [items, location, fin] = await Promise.all([this.repo.getItems(bookingId), this.directory.getLocation(b.location_id), this.repo.getFinancials(bookingId)]);
    const timezone = location?.timezone ?? 'UTC';
    return {
      id: b.id,
      reference: b.booking_ref,
      status: b.status,
      customerId: b.customer_id,
      providerId: b.provider_id,
      locationId: b.location_id,
      locationName: location?.name ?? null,
      resourceId: b.resource_id,
      // Several services read as "Haircut + Facial" in every notification, support case and review.
      serviceName: items.length > 0 ? items.map((i) => i.name).join(' + ') : 'Appointment',
      startAt: b.start_at,
      localStart: localDateTime(b.start_at.getTime(), timezone),
      timezone,
      closedAt: b.closed_at,
      priceMinor: items.reduce((sum, i) => sum + BigInt(i.price_minor), 0n),
      grossMinor: BigInt(fin?.gross_minor ?? 0),
      currency: items[0]?.currency ?? 'INR',
    };
  }

  /** The booking's state transitions, oldest first (for the case file an administrator reads). No authorization: callers decide. */
  async timeline(bookingId: string) {
    const rows = await this.repo.listEvents(bookingId);
    return rows.map((e) => ({ type: e.event_type, from_status: e.from_status, to_status: e.to_status, actor_type: e.actor_type, reason_code: e.reason_code, occurred_at: e.occurred_at.toISOString() }));
  }
}
