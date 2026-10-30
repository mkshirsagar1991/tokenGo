import type { Generated } from 'kysely';

export type BookingFlowType = 'APPOINTMENT_SLOT' | 'TABLE_RESERVATION' | 'SERVICE_REQUEST_WINDOW' | 'TEST_ORDER_WITH_COLLECTION';

export interface CategoriesTable {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: Generated<boolean>;
  booking_flow_type: Generated<BookingFlowType>;
  config: Generated<Record<string, unknown>>;
  sort_order: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ServiceTypesTable {
  id: string;
  category_id: string;
  code: string;
  name: string;
  description: string | null;
  attribute_schema: Generated<Record<string, unknown>>;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProviderServicesTable {
  id: string;
  provider_id: string;
  service_type_id: string;
  name: string;
  description: string | null;
  /** bigint column: `pg` returns it as a string; converted explicitly at the repository boundary. */
  price_minor: string | number;
  currency: Generated<string>;
  duration_min: number;
  buffer_min: Generated<number>;
  is_active: Generated<boolean>;
  attributes: Generated<Record<string, unknown>>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface ResourceServicesTable {
  resource_id: string;
  provider_service_id: string;
  created_at: Generated<Date>;
}

export interface CommissionRulesTable {
  id: string;
  scope_type: 'PLATFORM' | 'CATEGORY' | 'SERVICE_TYPE' | 'PROVIDER' | 'PROVIDER_SERVICE';
  scope_id: string | null;
  kind: 'PERCENT' | 'FIXED';
  percent_bps: number | null;
  fixed_minor: string | null;
  currency: Generated<string>;
  effective_from: Date;
  effective_to: Date | null;
  version: Generated<number>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface CancellationPoliciesTable {
  id: string;
  name: string;
  scope_type: 'PLATFORM' | 'CATEGORY' | 'PROVIDER';
  scope_id: string | null;
  no_show_refund_bps: number;
  provider_cancel_refund_bps: number;
  effective_from: Date;
  effective_to: Date | null;
  version: Generated<number>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface CancellationPolicyTiersTable {
  policy_id: string;
  min_hours_before: number;
  refund_bps: number;
}

export interface CatalogDb {
  'catalog.commission_rules': CommissionRulesTable;
  'catalog.cancellation_policies': CancellationPoliciesTable;
  'catalog.cancellation_policy_tiers': CancellationPolicyTiersTable;
  'catalog.resource_services': ResourceServicesTable;
  'catalog.categories': CategoriesTable;
  'catalog.service_types': ServiceTypesTable;
  'catalog.provider_services': ProviderServicesTable;
}
