import type { MoneyJson } from '@/lib/money';

export interface ReconciliationRecord {
  status: string;
  reference?: string | null;
  provider_payment_id?: string | null;
  payment_transaction_id?: string | null;
  payout_id?: string | null;
  expected: MoneyJson | null;
  actual: MoneyJson | null;
  detail: string;
}

export interface ReconciliationResult {
  id: string;
  provider: string;
  period_from: string;
  period_to: string;
  matched: number;
  exceptions: number;
  records: ReconciliationRecord[];
}
