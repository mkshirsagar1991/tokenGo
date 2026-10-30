import type { MoneyJson } from '@/lib/money';

export type TxStatus = 'CAPTURED' | 'FAILED' | 'QUARANTINED';
export const TX_STATUSES: readonly TxStatus[] = ['CAPTURED', 'FAILED', 'QUARANTINED'];
export type RefundStatus = 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
export const REFUND_STATUSES: readonly RefundStatus[] = ['PROCESSING', 'SUCCEEDED', 'FAILED'];
export type WebhookStatus = 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'REJECTED' | 'FAILED';
export const WEBHOOK_STATUSES: readonly WebhookStatus[] = ['RECEIVED', 'PROCESSED', 'IGNORED', 'REJECTED', 'FAILED'];

export interface PaymentTransaction {
  id: string;
  intent_id: string;
  customer_id: string;
  provider: string;
  provider_payment_id: string | null;
  status: TxStatus;
  amount: MoneyJson;
  failure_reason: string | null;
  ledger_txn_id: string | null;
  created_at: string;
}

export interface WebhookEvent {
  id: string;
  provider: string;
  provider_event_id: string | null;
  event_type: string | null;
  signature_valid: boolean;
  status: WebhookStatus;
  outcome: string | null;
  attempts: number;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface Refund {
  id: string;
  payment_transaction_id: string;
  amount: MoneyJson;
  status: RefundStatus;
  reason: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** What each webhook outcome means. A re-delivered event is recognised by its provider event id and acknowledged without a new row. */
export const WEBHOOK_OUTCOMES: Record<string, { label: string; help: string; tone: 'success' | 'neutral' | 'warn' | 'danger' }> = {
  CREDITED: { label: 'Credited', help: 'The payment was verified with the provider and the customer’s wallet was credited.', tone: 'success' },
  ALREADY_PROCESSED: { label: 'Duplicate (already handled)', help: 'This provider payment had been handled before; nothing was credited twice.', tone: 'neutral' },
  NOT_FINAL: { label: 'Not final yet', help: 'Authorised but not captured (or undecided): not money yet; looked at again later.', tone: 'warn' },
  FAILURE_RECORDED: { label: 'Failure recorded', help: 'A failed attempt was kept for the record; the intent stays open.', tone: 'neutral' },
  IGNORED_STALE_FAILURE: { label: 'Stale failure ignored', help: 'A “failed” report for a payment we already know was captured; it never regresses.', tone: 'neutral' },
  QUARANTINED: { label: 'Quarantined', help: 'Captured but it does not match the intent (e.g. amount). NOT credited; needs a person.', tone: 'danger' },
  UNKNOWN_ORDER: { label: 'Unknown order', help: 'Not one of our payments.', tone: 'neutral' },
  COMPLETED: { label: 'Refund completed', help: 'The provider confirmed the refund; the ledger was completed.', tone: 'success' },
  ABORTED: { label: 'Refund aborted', help: 'The provider refused the refund; the customer’s wallet was restored.', tone: 'warn' },
  PENDING: { label: 'Refund pending', help: 'The provider has not finished the refund.', tone: 'warn' },
  ALREADY_FINAL: { label: 'Already final', help: 'The refund was already settled; nothing changed.', tone: 'neutral' },
  UNKNOWN_REFUND: { label: 'Unknown refund', help: 'Not one of our refunds.', tone: 'neutral' },
};
