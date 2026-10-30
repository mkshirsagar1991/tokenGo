import type { ColumnType, Generated, RawBuilder } from 'kysely';
import type { ProviderStatus } from '../domain/provider-status';

export interface ProvidersTable {
  id: string;
  owner_user_id: string;
  display_name: string;
  description: string | null;
  status: ProviderStatus;
  submitted_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  decision_reason: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface ProviderLocationsTable {
  id: string;
  provider_id: string;
  name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: Generated<string>;
  /** Written with ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography; read back via ST_X/ST_Y. */
  geog: ColumnType<unknown, RawBuilder<unknown>, RawBuilder<unknown>>;
  timezone: Generated<string>;
  status: Generated<'ACTIVE' | 'INACTIVE'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface BookableResourcesTable {
  id: string;
  location_id: string;
  kind: Generated<'STAFF' | 'TABLE' | 'ROOM' | 'VEHICLE_BAY'>;
  display_name: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProviderStaffTable {
  id: string;
  provider_id: string;
  location_id: string;
  user_id: string | null;
  invited_phone_hash: string | null;
  resource_id: string | null;
  display_name: string;
  staff_role: Generated<'MANAGER' | 'STAFF'>;
  status: Generated<'INVITED' | 'ACTIVE' | 'INACTIVE'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface ProviderDb {
  'provider.providers': ProvidersTable;
  'provider.provider_locations': ProviderLocationsTable;
  'provider.bookable_resources': BookableResourcesTable;
  'provider.provider_staff': ProviderStaffTable;
}
