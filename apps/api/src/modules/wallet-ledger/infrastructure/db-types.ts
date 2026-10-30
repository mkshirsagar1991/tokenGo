import type { Generated } from 'kysely';

export type AccountType =
  | 'CUSTOMER_AVAILABLE'
  | 'CUSTOMER_HELD'
  | 'PROVIDER_PAYABLE'
  | 'PLATFORM_COMMISSION'
  | 'GATEWAY_CLEARING'
  | 'PAYOUT_CLEARING'
  | 'REFUND_CLEARING'
  | 'ADJUSTMENT';

export interface AccountsTable {
  id: string;
  owner_type: 'CUSTOMER' | 'PROVIDER' | 'PLATFORM';
  owner_id: string | null;
  account_type: AccountType;
  currency: string;
  normal_side: 'DEBIT' | 'CREDIT';
  /** bigint => string at the pg boundary; converted with BigInt() in the repository. */
  balance_minor: Generated<string>;
  last_seq: Generated<string>;
  created_at: Generated<Date>;
}

export interface WalletAccountsTable {
  customer_id: string;
  currency: string;
  available_account_id: string;
  held_account_id: string;
  status: Generated<'ACTIVE' | 'FROZEN' | 'CLOSED'>;
  created_at: Generated<Date>;
}

export interface TransactionsTable {
  id: string;
  txn_type: string;
  currency: string;
  business_ref_type: string | null;
  business_ref_id: string | null;
  booking_id: string | null;
  idempotency_key: string;
  reverses_txn_id: string | null;
  actor_type: 'USER' | 'SYSTEM';
  actor_id: string | null;
  correlation_id: string | null;
  audit_metadata: Generated<unknown>;
  posted_at: Date;
}

export interface EntriesTable {
  id: string;
  txn_id: string;
  account_id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_minor: string;
  account_seq: string;
  balance_after_minor: string;
  created_at: Generated<Date>;
}

export interface HoldsTable {
  id: string;
  booking_id: string;
  customer_id: string;
  purpose: 'BOOKING' | 'ADDITIONAL_CHARGE';
  amount_minor: string;
  currency: string;
  status: Generated<'ACTIVE' | 'RELEASED' | 'SETTLED'>;
  funding_source: Generated<'WALLET' | 'PSP_AUTHORIZATION'>;
  create_txn_id: string;
  close_txn_id: string | null;
  close_reason: string | null;
  created_at: Date;
  closed_at: Date | null;
}

export interface LedgerDb {
  'ledger.accounts': AccountsTable;
  'ledger.wallet_accounts': WalletAccountsTable;
  'ledger.transactions': TransactionsTable;
  'ledger.entries': EntriesTable;
  'ledger.holds': HoldsTable;
}
