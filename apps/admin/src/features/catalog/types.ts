import type { MoneyJson } from '@/lib/money';

export const FLOW_TYPES = ['APPOINTMENT_SLOT', 'TABLE_RESERVATION', 'SERVICE_REQUEST_WINDOW', 'TEST_ORDER_WITH_COLLECTION'] as const;
export const CODE_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export interface Category {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  booking_flow_type: string;
  config: Record<string, unknown>;
  sort_order: number;
  version: number;
}

export interface ServiceType {
  id: string;
  category_id: string;
  code: string;
  name: string;
  description: string | null;
  attribute_schema: Record<string, unknown>;
  is_active: boolean;
  sort_order: number;
}

export type CommissionScope = 'PLATFORM' | 'CATEGORY' | 'SERVICE_TYPE' | 'PROVIDER' | 'PROVIDER_SERVICE';
export type CancellationScope = 'PLATFORM' | 'CATEGORY' | 'PROVIDER';

interface Versioned {
  id: string;
  scope_id: string | null;
  effective_from: string;
  effective_to: string | null;
  version: number;
}

export interface CommissionRule extends Versioned {
  scope_type: CommissionScope;
  kind: 'PERCENT' | 'FIXED';
  percent_bps: number | null;
  fixed: MoneyJson | null;
}

export interface CancellationPolicy extends Versioned {
  name: string;
  scope_type: CancellationScope;
  no_show_refund_bps: number;
  provider_cancel_refund_bps: number;
  /** NOT returned by the list endpoint today (API gap): present only if the API starts sending it. */
  tiers?: Array<{ min_hours_before: number; refund_bps: number }>;
}

export interface ScopeOptions {
  categories: Array<{ value: string; label: string }>;
  providers: Array<{ value: string; label: string }>;
}
