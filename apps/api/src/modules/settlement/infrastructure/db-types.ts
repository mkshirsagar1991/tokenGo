import type { Generated, Selectable } from 'kysely';

export type AccountStatus = 'PENDING_VERIFICATION' | 'VERIFIED' | 'VERIFICATION_FAILED' | 'REPLACED';
export type PayoutStatus = 'RESERVED' | 'SUBMITTED' | 'PAID' | 'FAILED';
export type PayableStatus = 'ACCRUED' | 'IN_PAYOUT' | 'PAID' | 'CLAWED_BACK';
export type SettlementReconStatus = 'MATCHED' | 'AMOUNT_MISMATCH' | 'STATUS_MISMATCH' | 'MISSING_INTERNAL' | 'MISSING_EXTERNAL';

// bigint columns arrive from `pg` as strings; they are converted with BigInt() at the edge.
export interface PayoutAccountsTable {
  id: string;
  provider_id: string;
  holder_name_enc: Buffer;
  account_number_enc: Buffer;
  ifsc: string;
  account_last4: string;
  account_hash: string;
  status: Generated<AccountStatus>;
  verification_ref: string;
  failure_reason: string | null;
  verified_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface PayoutHoldsTable {
  provider_id: string;
  reason: string;
  held_by: string | null;
  automatic: Generated<boolean>;
  created_at: Date;
}

export interface PayoutsTable {
  id: string;
  provider_id: string;
  payout_account_id: string;
  currency: string;
  amount_minor: string;
  status: Generated<PayoutStatus>;
  provider_name: string;
  provider_reference: string;
  provider_payout_id: string | null;
  utr: string | null;
  provider_created_at: Date | null;
  attempts: Generated<number>;
  last_error: string | null;
  failure_reason: string | null;
  needs_review: Generated<boolean>;
  reserve_txn_id: string | null;
  close_txn_id: string | null;
  created_at: Date;
  submitted_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

export interface ProviderPayablesTable {
  id: string;
  provider_id: string;
  ledger_txn_id: string;
  booking_id: string | null;
  currency: string;
  net_minor: string;
  commission_minor: string;
  status: Generated<PayableStatus>;
  eligible_at: Date;
  payout_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PayoutItemsTable {
  payout_id: string;
  payable_id: string;
}

export interface ReconciliationRunsTable {
  id: string;
  provider_name: string;
  period_from: Date;
  period_to: Date;
  started_by: string | null;
  matched: Generated<number>;
  exceptions: Generated<number>;
  created_at: Date;
}

export interface ReconciliationRecordsTable {
  id: string;
  run_id: string;
  status: SettlementReconStatus;
  external_ref: string | null;
  internal_ref: string | null;
  expected_minor: string | null;
  actual_minor: string | null;
  detail: string | null;
  created_at: Date;
}

export interface SandboxBankChecksTable {
  reference: string;
  account_hash: string;
  name_at_bank: string | null;
  status: 'VERIFIED' | 'FAILED' | 'PENDING';
  failure_reason: string | null;
  created_at: Date;
}

export interface SandboxPayoutsTable {
  provider_payout_id: string;
  reference: string;
  amount_minor: string;
  currency: string;
  destination_last4: string;
  status: 'QUEUED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REVERSED';
  utr: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SettlementDb {
  'settlement.payout_accounts': PayoutAccountsTable;
  'settlement.payout_holds': PayoutHoldsTable;
  'settlement.payouts': PayoutsTable;
  'settlement.provider_payables': ProviderPayablesTable;
  'settlement.payout_items': PayoutItemsTable;
  'settlement.reconciliation_runs': ReconciliationRunsTable;
  'settlement.reconciliation_records': ReconciliationRecordsTable;
  'settlement.sandbox_bank_checks': SandboxBankChecksTable;
  'settlement.sandbox_payouts': SandboxPayoutsTable;
}

export type PayoutAccountRow = Selectable<PayoutAccountsTable>;
export type PayoutRow = Selectable<PayoutsTable>;
export type PayableRow = Selectable<ProviderPayablesTable>;
