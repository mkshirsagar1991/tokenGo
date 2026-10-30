import type { MoneyJson } from '@/lib/money';

export type PayoutStatus = 'RESERVED' | 'SUBMITTED' | 'PAID' | 'FAILED';
export const PAYOUT_STATUSES: readonly PayoutStatus[] = ['RESERVED', 'SUBMITTED', 'PAID', 'FAILED'];
export type PayableStatus = 'ACCRUED' | 'IN_PAYOUT' | 'PAID' | 'CLAWED_BACK';
export const PAYABLE_STATUSES: readonly PayableStatus[] = ['ACCRUED', 'IN_PAYOUT', 'PAID', 'CLAWED_BACK'];
export type AccountStatus = 'PENDING_VERIFICATION' | 'VERIFIED' | 'VERIFICATION_FAILED' | 'REPLACED';
export const ACCOUNT_STATUSES: readonly AccountStatus[] = ['PENDING_VERIFICATION', 'VERIFIED', 'VERIFICATION_FAILED', 'REPLACED'];

export interface Payout {
  id: string;
  amount: MoneyJson;
  status: PayoutStatus;
  utr: string | null;
  failure_reason: string | null;
  created_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  provider_id: string;
  /** The payout PROVIDER (the bank-transfer service, e.g. "sandbox"), not the salon. */
  provider: string | null;
  provider_payout_id: string | null;
  reference: string | null;
  attempts: number;
  last_error: string | null;
  needs_review: boolean;
}

export interface PayoutDetail extends Payout {
  items: Array<{ payable_id: string; booking_id: string; net: MoneyJson }>;
}

export interface Payable {
  id: string;
  provider_id: string;
  booking_id: string;
  net: MoneyJson;
  commission: MoneyJson;
  status: PayableStatus;
  eligible_at: string;
  payout_id: string | null;
  created_at: string;
}

export interface PayoutAccount {
  id: string;
  provider_id: string;
  holder_name: string;
  ifsc: string;
  account_number: string;
  status: AccountStatus;
  failure_reason: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface PayoutHold {
  provider_id: string;
  reason: string;
  automatic: boolean;
  since: string;
}

export interface BatchResult {
  batch: { payouts: number; considered: number; skipped: Partial<Record<string, number>> };
  sweep: { payouts: number; accounts: number };
}

/** What each reason the API gives for skipping a provider in a payout run means, in plain words. */
export const SKIP_REASONS: Record<string, string> = {
  PAYOUTS_DISABLED: 'Payouts are disabled on this environment (no payout provider is enabled)',
  PAUSED: 'The provider’s payouts are frozen',
  PROVIDER_NOT_APPROVED: 'The provider is not approved',
  NO_VERIFIED_ACCOUNT: 'No verified bank account',
  ACCOUNT_COOLING_OFF: 'The bank account was verified recently and is still in its cooling-off period',
  PAYOUT_IN_FLIGHT: 'A payout for this provider is already in flight',
  BELOW_MINIMUM: 'Eligible money is below the minimum payout',
  LEDGER_MISMATCH: 'The ledger and the payable rows disagree (not paid; needs investigation)',
};
