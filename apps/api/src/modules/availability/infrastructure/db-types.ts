import type { Generated } from 'kysely';

export interface AvailabilityRulesTable {
  id: string;
  location_id: string | null;
  resource_id: string | null;
  rule_type: 'WORKING' | 'BREAK';
  weekday: number;
  start_min: number;
  end_min: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AvailabilityExceptionsTable {
  id: string;
  location_id: string | null;
  resource_id: string | null;
  kind: 'CLOSED' | 'OPEN';
  /** Selected as text (`::text`) so a `date` never passes through a JS Date and its timezone. */
  start_date: string;
  end_date: string;
  start_min: number | null;
  end_min: number | null;
  reason: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface ResourceReservationsTable {
  id: string;
  resource_id: string;
  start_at: Date;
  end_at: Date;
  kind: 'BLOCK' | 'BOOKING';
  status: Generated<'ACTIVE' | 'RELEASED'>;
  booking_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  released_at: Date | null;
}

export interface BookingPoliciesTable {
  id: string;
  scope_type: 'PLATFORM' | 'PROVIDER';
  provider_id: string | null;
  slot_granularity_min: number | null;
  min_lead_time_min: number | null;
  max_advance_days: number | null;
  response_deadline_min: number | null;
  check_in_window_min: number | null;
  no_show_grace_min: number | null;
  settlement_hold_hours: number | null;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface AvailabilityDb {
  'scheduling.availability_rules': AvailabilityRulesTable;
  'scheduling.availability_exceptions': AvailabilityExceptionsTable;
  'scheduling.resource_reservations': ResourceReservationsTable;
  'scheduling.booking_policies': BookingPoliciesTable;
}
