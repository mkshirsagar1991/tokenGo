import type { Generated, Selectable } from 'kysely';

export type IntentStatus = 'PENDING' | 'SUCCEEDED' | 'EXPIRED' | 'CANCELLED';
export type PaymentTxStatus = 'CAPTURED' | 'FAILED' | 'QUARANTINED';
export type RefundStatus = 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
export type WebhookStatus = 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'REJECTED' | 'FAILED';
export type ReconciliationStatus = 'MATCHED' | 'AMOUNT_MISMATCH' | 'MISSING_INTERNAL' | 'MISSING_EXTERNAL' | 'REFUND_MISMATCH';

// bigint columns arrive from `pg` as strings; they are converted with BigInt() at the edge.
export interface PaymentIntentsTable {
  id: string;
  customer_id: string;
  purpose: Generated<'WALLET_TOPUP'>;
  amount_minor: string;
  currency: string;
  provider: string;
  provider_order_id: string;
  status: Generated<IntentStatus>;
  idempotency_key: string;
  expires_at: Date;
  succeeded_at: Date | null;
  created_at: Date;
  updated_at: Generated<Date>;
}

export interface PaymentTransactionsTable {
  id: string;
  intent_id: string;
  provider: string;
  provider_payment_id: string;
  status: PaymentTxStatus;
  amount_minor: string;
  currency: string;
  ledger_txn_id: string | null;
  provider_created_at: Date;
  verified_at: Date;
  failure_reason: string | null;
  created_at: Generated<Date>;
}

export interface WebhookEventsTable {
  id: string;
  provider: string;
  provider_event_id: string | null;
  event_type: string | null;
  signature_valid: boolean;
  payload: unknown;
  processing_status: Generated<WebhookStatus>;
  attempts: Generated<number>;
  outcome: string | null;
  last_error: string | null;
  received_at: Date;
  processed_at: Date | null;
}

export interface RefundsTable {
  id: string;
  payment_transaction_id: string;
  customer_id: string;
  amount_minor: string;
  currency: string;
  status: Generated<RefundStatus>;
  provider: string;
  provider_refund_id: string | null;
  reason: string;
  requested_by: string;
  idempotency_key: string;
  reserve_txn_id: string | null;
  close_txn_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Generated<Date>;
}

export interface ReconciliationRunsTable {
  id: string;
  provider: string;
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
  status: ReconciliationStatus;
  external_ref: string | null;
  internal_ref: string | null;
  expected_minor: string | null;
  actual_minor: string | null;
  detail: string | null;
  created_at: Date;
}

export interface SandboxOrdersTable {
  provider_order_id: string;
  amount_minor: string;
  currency: string;
  receipt: string | null;
  created_at: Date;
}

export interface SandboxPaymentsTable {
  provider_payment_id: string;
  provider_order_id: string;
  amount_minor: string;
  currency: string;
  status: 'CAPTURED' | 'FAILED';
  created_at: Date;
}

export interface SandboxRefundsTable {
  provider_refund_id: string;
  provider_payment_id: string;
  amount_minor: string;
  idempotency_key: string;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  created_at: Date;
}

/** Row shapes as read back from the database (defaults resolved). */
export type IntentRow = Selectable<PaymentIntentsTable>;
export type RefundRow = Selectable<RefundsTable>;

export interface PaymentsDb {
  'payments.payment_intents': PaymentIntentsTable;
  'payments.payment_transactions': PaymentTransactionsTable;
  'payments.webhook_events': WebhookEventsTable;
  'payments.refunds': RefundsTable;
  'payments.reconciliation_runs': ReconciliationRunsTable;
  'payments.reconciliation_records': ReconciliationRecordsTable;
  'payments.sandbox_orders': SandboxOrdersTable;
  'payments.sandbox_payments': SandboxPaymentsTable;
  'payments.sandbox_refunds': SandboxRefundsTable;
}
