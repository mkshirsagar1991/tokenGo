-- Up Migration
-- Reconciliation can now flag a payment the provider shows as refunded by MORE than we ever asked it to refund — i.e. a
-- refund made outside our system (e.g. someone pressing "Refund" in the provider's dashboard) that our books know nothing
-- about. Money left the platform and the customer's wallet was never reduced.
ALTER TABLE payments.reconciliation_records DROP CONSTRAINT reconciliation_records_status_check;
ALTER TABLE payments.reconciliation_records
  ADD CONSTRAINT reconciliation_records_status_check
  CHECK (status IN ('MATCHED', 'AMOUNT_MISMATCH', 'MISSING_INTERNAL', 'MISSING_EXTERNAL', 'REFUND_MISMATCH'));

-- Down Migration
