import type { Generated } from 'kysely';
import type { BookingStatus } from '../domain/booking-state';

export type FundsStatus = 'NONE' | 'HELD' | 'RELEASED' | 'SETTLED' | 'PARTIAL';
export type SettlementStatus = 'NOT_DUE' | 'PENDING' | 'FROZEN' | 'DONE';

export interface BookingsTable {
  id: string;
  booking_ref: string;
  customer_id: string;
  provider_id: string;
  location_id: string;
  resource_id: string;
  reservation_id: string;
  status: BookingStatus;
  funds_status: Generated<FundsStatus>;
  settlement_status: Generated<SettlementStatus>;
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
  idempotency_key: string;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BookingItemsTable {
  id: string;
  booking_id: string;
  provider_service_id: string;
  service_version: number;
  name: string;
  price_minor: string;
  currency: string;
  duration_min: number;
  buffer_min: number;
  /** The order the customer chose the services in (0 = first). */
  position: number;
}

export interface BookingFinancialsTable {
  booking_id: string;
  currency: string;
  gross_minor: string;
  discount_minor: Generated<string>;
  tax_minor: Generated<string>;
  commission_rule_id: string | null;
  commission_rule_version: number | null;
  commission_kind: 'PERCENT' | 'FIXED';
  commission_bps: number | null;
  commission_fixed_minor: string | null;
  cancellation_policy: unknown;
  hold_id: string | null;
}

export interface BookingEventsTable {
  id: string;
  booking_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: 'CUSTOMER' | 'PROVIDER' | 'ADMIN' | 'SYSTEM';
  actor_id: string | null;
  reason_code: string | null;
  metadata: Generated<unknown>;
  occurred_at: Date;
}

export interface BookingVerificationsTable {
  booking_id: string;
  failed_attempts: Generated<number>;
  locked_until: Date | null;
}

export interface BookingDb {
  'booking.bookings': BookingsTable;
  'booking.booking_items': BookingItemsTable;
  'booking.booking_financials': BookingFinancialsTable;
  'booking.booking_events': BookingEventsTable;
  'booking.booking_verifications': BookingVerificationsTable;
}
