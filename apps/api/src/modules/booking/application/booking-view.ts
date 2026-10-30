import { Injectable } from '@nestjs/common';
import { Clock, Money } from '../../../shared-kernel';
import { localDateTime } from '../../availability';
import { customerRefundBps, splitRefund } from '../../catalog';
import { ProviderDirectoryService } from '../../provider-management';
import { BookingRepository, BookingRow } from '../infrastructure/booking.repository';

export interface BookingView {
  id: string;
  reference: string;
  status: string;
  funds_status: string;
  settlement_status: string;
  customer_id: string;
  provider_id: string;
  location_id: string;
  location_name: string | null;
  staff_resource_id: string;
  /** The stylist (or other bookable resource) the visit is with, as the salon names them; null if it can no longer be looked up. */
  staff_name: string | null;
  /** The whole visit as one block: with several services the names are joined ("Haircut + Facial") and the times are the visit's. */
  service: { id: string; name: string; duration_min: number; buffer_min: number; version: number };
  /** The services one by one, in the order they were chosen (always at least one). */
  services: { id: string; name: string; price: { amount_minor: number; currency: string }; duration_min: number; buffer_min: number; version: number }[];
  /** The total of all the services. */
  price: { amount_minor: number; currency: string };
  schedule: { start_at: string; end_at: string; local_start: string; timezone: string };
  response_deadline_at: string | null;
  timeline: { requested_at: string; confirmed_at: string | null; arrived_at: string | null; started_at: string | null; completed_at: string | null; closed_at: string | null };
  settle_after: string | null;
  status_reason: string | null;
  note: string | null;
  cancellation: { policy: string; refund_if_cancelled_now: { bps: number; amount: { amount_minor: number; currency: string } } | null };
}

/** Turns a booking row into the API shape. Money is always `{ amount_minor, currency }`. */
@Injectable()
export class BookingViewBuilder {
  constructor(
    private readonly repo: BookingRepository,
    private readonly directory: ProviderDirectoryService,
    private readonly clock: Clock,
  ) {}

  async build(b: BookingRow): Promise<BookingView> {
    const [items, fin, location, resource] = await Promise.all([
      this.repo.getItems(b.id),
      this.repo.getFinancials(b.id),
      this.directory.getLocation(b.location_id),
      this.directory.getResource(b.resource_id),
    ]);
    const first = items[0]!;
    const tz = location?.timezone ?? 'UTC';
    const price = items.reduce((sum, i) => sum.add(Money.of(BigInt(i.price_minor), i.currency)), Money.zero(first.currency));
    const minutes = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);

    // What would the customer get back if they cancelled right now (only meaningful while cancellable)?
    let refundNow: BookingView['cancellation']['refund_if_cancelled_now'] = null;
    if (fin && (b.status === 'REQUESTED' || b.status === 'CONFIRMED')) {
      const bps = b.status === 'REQUESTED' ? 10000 : customerRefundBps(fin.cancellation_policy.tiers, (b.start_at.getTime() - this.clock.now().getTime()) / 3_600_000);
      refundNow = { bps, amount: splitRefund(price, bps).refund.toJSON() };
    }

    return {
      id: b.id,
      reference: b.booking_ref,
      status: b.status,
      funds_status: b.funds_status,
      settlement_status: b.settlement_status,
      customer_id: b.customer_id,
      provider_id: b.provider_id,
      location_id: b.location_id,
      location_name: location?.name ?? null,
      staff_resource_id: b.resource_id,
      staff_name: resource?.displayName ?? null,
      service: { id: first.provider_service_id, name: items.map((i) => i.name).join(' + '), duration_min: minutes(b.start_at, b.end_at), buffer_min: minutes(b.end_at, b.occupied_until), version: first.service_version },
      services: items.map((i) => ({ id: i.provider_service_id, name: i.name, price: Money.of(BigInt(i.price_minor), i.currency).toJSON(), duration_min: i.duration_min, buffer_min: i.buffer_min, version: i.service_version })),
      price: price.toJSON(),
      schedule: { start_at: b.start_at.toISOString(), end_at: b.end_at.toISOString(), local_start: localDateTime(b.start_at.getTime(), tz), timezone: tz },
      response_deadline_at: b.response_deadline_at?.toISOString() ?? null,
      timeline: {
        requested_at: b.requested_at.toISOString(),
        confirmed_at: b.confirmed_at?.toISOString() ?? null,
        arrived_at: b.arrived_at?.toISOString() ?? null,
        started_at: b.started_at?.toISOString() ?? null,
        completed_at: b.completed_at?.toISOString() ?? null,
        closed_at: b.closed_at?.toISOString() ?? null,
      },
      settle_after: b.settle_after?.toISOString() ?? null,
      status_reason: b.status_reason,
      note: b.customer_note,
      cancellation: { policy: fin?.cancellation_policy.name ?? 'n/a', refund_if_cancelled_now: refundNow },
    };
  }
}
