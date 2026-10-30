import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { UnitOfWork, uuidv7 } from '../../../shared-kernel';
import type { BookingStatus } from '../domain/booking-state';
import type { BookingDb, FundsStatus, SettlementStatus } from './db-types';

export interface BookingRow {
  id: string;
  booking_ref: string;
  customer_id: string;
  provider_id: string;
  location_id: string;
  resource_id: string;
  reservation_id: string;
  status: BookingStatus;
  funds_status: FundsStatus;
  settlement_status: SettlementStatus;
  start_at: Date;
  end_at: Date;
  occupied_until: Date;
  response_deadline_at: Date | null;
  settle_after: Date | null;
  requested_at: Date;
  confirmed_at: Date | null;
  arrived_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  customer_note: string | null;
  status_reason: string | null;
  version: number;
  created_at: Date;
}

export interface NewBooking {
  id: string;
  bookingRef: string;
  customerId: string;
  providerId: string;
  locationId: string;
  resourceId: string;
  reservationId: string;
  startAt: Date;
  endAt: Date;
  occupiedUntil: Date;
  responseDeadlineAt: Date;
  requestedAt: Date;
  customerNote: string | null;
  idempotencyKey: string;
}

export interface BookingPatch {
  fundsStatus?: FundsStatus;
  settlementStatus?: SettlementStatus;
  settleAfter?: Date | null;
  confirmedAt?: Date;
  arrivedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  closedAt?: Date;
  statusReason?: string | null;
}

@Injectable()
export class BookingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.db<BookingDb>();
  }

  private bookingSelect() {
    return this.db.selectFrom('booking.bookings').select([
      'id',
      'booking_ref',
      'customer_id',
      'provider_id',
      'location_id',
      'resource_id',
      'reservation_id',
      'status',
      'funds_status',
      'settlement_status',
      'start_at',
      'end_at',
      'occupied_until',
      'response_deadline_at',
      'settle_after',
      'requested_at',
      'confirmed_at',
      'arrived_at',
      'started_at',
      'completed_at',
      'closed_at',
      'customer_note',
      'status_reason',
      'version',
      'created_at',
    ]);
  }

  async insertBooking(b: NewBooking): Promise<void> {
    await this.db
      .insertInto('booking.bookings')
      .values({
        id: b.id,
        booking_ref: b.bookingRef,
        customer_id: b.customerId,
        provider_id: b.providerId,
        location_id: b.locationId,
        resource_id: b.resourceId,
        reservation_id: b.reservationId,
        status: 'REQUESTED',
        funds_status: 'HELD',
        start_at: b.startAt,
        end_at: b.endAt,
        occupied_until: b.occupiedUntil,
        response_deadline_at: b.responseDeadlineAt,
        settle_after: null,
        requested_at: b.requestedAt,
        confirmed_at: null,
        arrived_at: null,
        started_at: null,
        completed_at: null,
        closed_at: null,
        customer_note: b.customerNote,
        status_reason: null,
        idempotency_key: b.idempotencyKey,
      })
      .execute();
  }

  async insertItem(row: { bookingId: string; providerServiceId: string; serviceVersion: number; name: string; priceMinor: bigint; currency: string; durationMin: number; bufferMin: number; position: number }) {
    await this.db
      .insertInto('booking.booking_items')
      .values({
        id: uuidv7(),
        booking_id: row.bookingId,
        provider_service_id: row.providerServiceId,
        service_version: row.serviceVersion,
        name: row.name,
        price_minor: row.priceMinor.toString(),
        currency: row.currency,
        duration_min: row.durationMin,
        buffer_min: row.bufferMin,
        position: row.position,
      })
      .execute();
  }

  async insertFinancials(row: {
    bookingId: string;
    currency: string;
    grossMinor: bigint;
    commissionRuleId: string | null;
    commissionRuleVersion: number | null;
    commissionKind: 'PERCENT' | 'FIXED';
    commissionBps: number | null;
    commissionFixedMinor: bigint | null;
    cancellationPolicy: unknown;
    holdId: string | null;
  }) {
    await this.db
      .insertInto('booking.booking_financials')
      .values({
        booking_id: row.bookingId,
        currency: row.currency,
        gross_minor: row.grossMinor.toString(),
        commission_rule_id: row.commissionRuleId,
        commission_rule_version: row.commissionRuleVersion,
        commission_kind: row.commissionKind,
        commission_bps: row.commissionBps,
        commission_fixed_minor: row.commissionFixedMinor === null ? null : row.commissionFixedMinor.toString(),
        cancellation_policy: JSON.stringify(row.cancellationPolicy),
        hold_id: row.holdId,
      })
      .execute();
    await this.db.insertInto('booking.booking_verifications').values({ booking_id: row.bookingId, locked_until: null }).execute();
  }

  findById(id: string, opts: { forUpdate?: boolean } = {}): Promise<BookingRow | undefined> {
    let q = this.bookingSelect().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst() as Promise<BookingRow | undefined>;
  }

  /** The services of a booking, in the order the customer chose them (always at least one). */
  getItems(bookingId: string) {
    return this.db.selectFrom('booking.booking_items').selectAll().where('booking_id', '=', bookingId).orderBy('position').orderBy('id').execute();
  }

  async getFinancials(bookingId: string) {
    const f = await this.db.selectFrom('booking.booking_financials').selectAll().where('booking_id', '=', bookingId).executeTakeFirst();
    if (!f) return undefined;
    return {
      ...f,
      cancellation_policy: (typeof f.cancellation_policy === 'string' ? JSON.parse(f.cancellation_policy) : f.cancellation_policy) as {
        policyId: string | null;
        policyVersion: number | null;
        name: string;
        tiers: { minHoursBefore: number; refundBps: number }[];
        noShowRefundBps: number;
        providerCancelRefundBps: number;
      },
    };
  }

  /** Compare-and-set the status. Zero rows => the booking moved since it was loaded. */
  async transition(id: string, expected: BookingStatus, next: BookingStatus, patch: BookingPatch): Promise<BookingRow | undefined> {
    const set: Record<string, unknown> = { status: next, version: sql<number>`version + 1` };
    if (patch.fundsStatus !== undefined) set['funds_status'] = patch.fundsStatus;
    if (patch.settlementStatus !== undefined) set['settlement_status'] = patch.settlementStatus;
    if (patch.settleAfter !== undefined) set['settle_after'] = patch.settleAfter;
    if (patch.confirmedAt) set['confirmed_at'] = patch.confirmedAt;
    if (patch.arrivedAt) set['arrived_at'] = patch.arrivedAt;
    if (patch.startedAt) set['started_at'] = patch.startedAt;
    if (patch.completedAt) set['completed_at'] = patch.completedAt;
    if (patch.closedAt) set['closed_at'] = patch.closedAt;
    if (patch.statusReason !== undefined) set['status_reason'] = patch.statusReason;
    await this.db.updateTable('booking.bookings').set(set).where('id', '=', id).where('status', '=', expected).execute();
    const after = await this.findById(id);
    return after && after.status === next ? after : undefined;
  }

  async insertEvent(e: { bookingId: string; eventType: string; fromStatus: string | null; toStatus: string | null; actorType: 'CUSTOMER' | 'PROVIDER' | 'ADMIN' | 'SYSTEM'; actorId: string | null; reasonCode: string | null; metadata?: Record<string, unknown>; occurredAt: Date }) {
    await this.db
      .insertInto('booking.booking_events')
      .values({
        id: uuidv7(),
        booking_id: e.bookingId,
        event_type: e.eventType,
        from_status: e.fromStatus,
        to_status: e.toStatus,
        actor_type: e.actorType,
        actor_id: e.actorId,
        reason_code: e.reasonCode,
        metadata: JSON.stringify(e.metadata ?? {}),
        occurred_at: e.occurredAt,
      })
      .execute();
  }

  listEvents(bookingId: string) {
    return this.db.selectFrom('booking.booking_events').selectAll().where('booking_id', '=', bookingId).orderBy('occurred_at').orderBy('id').execute();
  }

  // --- lists ----------------------------------------------------------------------------------------------------
  listForCustomer(customerId: string, f: { status?: BookingStatus; beforeId?: string; limit: number }) {
    let q = this.bookingSelect().where('customer_id', '=', customerId);
    if (f.status) q = q.where('status', '=', f.status);
    if (f.beforeId) q = q.where('id', '<', f.beforeId);
    return q.orderBy('id', 'desc').limit(f.limit).execute() as Promise<BookingRow[]>;
  }

  listForProvider(providerId: string, f: { locationId?: string; status?: BookingStatus; from?: Date; to?: Date; beforeId?: string; limit: number }) {
    let q = this.bookingSelect().where('provider_id', '=', providerId);
    if (f.locationId) q = q.where('location_id', '=', f.locationId);
    if (f.status) q = q.where('status', '=', f.status);
    if (f.from) q = q.where('start_at', '>=', f.from);
    if (f.to) q = q.where('start_at', '<', f.to);
    if (f.beforeId) q = q.where('id', '<', f.beforeId);
    return q.orderBy('id', 'desc').limit(f.limit).execute() as Promise<BookingRow[]>;
  }

  // --- arrival verification attempts -----------------------------------------------------------------------------
  getVerification(bookingId: string) {
    return this.db.selectFrom('booking.booking_verifications').selectAll().where('booking_id', '=', bookingId).forUpdate().executeTakeFirst();
  }

  recordVerificationFailure(bookingId: string, lockAfter: number, lockUntil: Date) {
    return this.db
      .updateTable('booking.booking_verifications')
      .set({
        failed_attempts: sql<number>`failed_attempts + 1`,
        locked_until: sql<Date | null>`CASE WHEN failed_attempts + 1 >= ${lockAfter} THEN ${lockUntil}::timestamptz ELSE locked_until END`,
      })
      .where('booking_id', '=', bookingId)
      .execute();
  }

  resetVerification(bookingId: string) {
    return this.db.updateTable('booking.booking_verifications').set({ failed_attempts: 0, locked_until: null }).where('booking_id', '=', bookingId).execute();
  }

  /** Booking ids whose scheduled work is overdue (for the sweeper). Cheap: both predicates are partial-indexed. */
  async findOverdue(cutoff: Date, limit: number): Promise<{ expiry: string[]; settlement: string[] }> {
    const expiry = await this.db.selectFrom('booking.bookings').select('id').where('status', '=', 'REQUESTED').where('response_deadline_at', '<', cutoff).orderBy('response_deadline_at').limit(limit).execute();
    const settlement = await this.db.selectFrom('booking.bookings').select('id').where('settlement_status', '=', 'PENDING').where('status', '=', 'SERVICE_COMPLETED').where('settle_after', '<', cutoff).orderBy('settle_after').limit(limit).execute();
    return { expiry: expiry.map((x) => x.id), settlement: settlement.map((x) => x.id) };
  }

  async bookingRefExists(ref: string): Promise<boolean> {
    return (await this.db.selectFrom('booking.bookings').select('id').where('booking_ref', '=', ref).executeTakeFirst()) !== undefined;
  }
}
