import Link from 'next/link';
import { Badge, StatusBadge } from '@/components/ui/feedback';
import { IdChip } from '@/components/ui/id';
import { TBody, TD, TH, THead, TR, TableCard, TableEmpty } from '@/components/ui/table';
import { formatDateTime, shortId } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { WEBHOOK_OUTCOMES, type PaymentTransaction, type Refund, type WebhookEvent } from '../types';
import { RefundButton } from './refund-dialog';

export function TransactionsTable({ rows }: { rows: PaymentTransaction[] }) {
  return (
    <TableCard caption="Payment transactions">
      <THead>
        <tr>
          <TH stickyFirst>Time</TH>
          <TH align="right">Amount</TH>
          <TH>Status</TH>
          <TH>Provider</TH>
          <TH>Provider payment</TH>
          <TH>Customer</TH>
          <TH>Ledger</TH>
          <TH>
            <span className="sr-only">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {rows.length === 0 ? (
          <TableEmpty colSpan={8}>No transactions match these filters.</TableEmpty>
        ) : (
          rows.map((t) => (
            <TR key={t.id}>
              <TD stickyFirst className="whitespace-nowrap">{formatDateTime(t.created_at)}</TD>
              <TD align="right" className="whitespace-nowrap font-medium">{formatMoney(t.amount)}</TD>
              <TD>
                <StatusBadge status={t.status} />
                {t.status === 'QUARANTINED' ? <p className="mt-1 max-w-52 text-xs text-warn-fg">Captured but not credited: it did not match the payment request. Needs a person.</p> : null}
                {t.failure_reason ? <p className="mt-1 max-w-52 text-xs text-danger-fg">{t.failure_reason}</p> : null}
              </TD>
              <TD>
                <Badge tone="info" title="The payment provider that took this payment">{t.provider}</Badge>
              </TD>
              <TD mono className="break-all">{t.provider_payment_id ?? '—'}</TD>
              <TD>
                <IdChip id={t.customer_id} label="customer id" />
              </TD>
              <TD>
                <IdChip id={t.ledger_txn_id} label="ledger transaction id" />
              </TD>
              <TD className="text-right">
                <RefundButton tx={t} />
              </TD>
            </TR>
          ))
        )}
      </TBody>
    </TableCard>
  );
}

export function WebhooksTable({ rows }: { rows: WebhookEvent[] }) {
  return (
    <TableCard caption="Payment provider webhook events">
      <THead>
        <tr>
          <TH stickyFirst>Received</TH>
          <TH>Signature</TH>
          <TH>State</TH>
          <TH>Outcome</TH>
          <TH>Event</TH>
          <TH>Tries</TH>
          <TH>Last error</TH>
        </tr>
      </THead>
      <TBody>
        {rows.length === 0 ? (
          <TableEmpty colSpan={7}>No webhook events match these filters.</TableEmpty>
        ) : (
          rows.map((w) => {
            const outcome = w.outcome ? (WEBHOOK_OUTCOMES[w.outcome] ?? { label: w.outcome, help: '', tone: 'neutral' as const }) : null;
            return (
              <TR key={w.id}>
                <TD stickyFirst className="whitespace-nowrap">{formatDateTime(w.received_at)}</TD>
                <TD>{w.signature_valid ? <Badge tone="success">Verified</Badge> : <Badge tone="danger" title="The signature did not verify; nothing from the request was trusted or stored">Invalid signature</Badge>}</TD>
                <TD>
                  <StatusBadge status={w.status} />
                </TD>
                <TD>{outcome ? <Badge tone={outcome.tone} title={outcome.help}>{outcome.label}</Badge> : <span className="text-fg-subtle">—</span>}</TD>
                <TD>
                  <span className="block text-xs">{w.event_type ?? '—'}</span>
                  <span className="block break-all font-mono text-xs text-fg-subtle">{w.provider_event_id ?? ''}</span>
                  <span className="text-xs text-fg-subtle">{w.provider}</span>
                </TD>
                <TD className="tabular-nums">{w.attempts}</TD>
                <TD className="max-w-xs break-words text-xs text-danger-fg">{w.last_error ?? ''}</TD>
              </TR>
            );
          })
        )}
      </TBody>
    </TableCard>
  );
}

export function RefundsTable({ rows }: { rows: Refund[] }) {
  return (
    <TableCard caption="Refunds">
      <THead>
        <tr>
          <TH stickyFirst>Created</TH>
          <TH align="right">Amount</TH>
          <TH>Status</TH>
          <TH>Reason</TH>
          <TH>Payment</TH>
          <TH>Refund</TH>
        </tr>
      </THead>
      <TBody>
        {rows.length === 0 ? (
          <TableEmpty colSpan={6}>No refunds match these filters.</TableEmpty>
        ) : (
          rows.map((r) => (
            <TR key={r.id}>
              <TD stickyFirst className="whitespace-nowrap">
                <Link href={`/payments/refunds/${r.id}`} className="text-brand-soft-fg hover:underline">
                  {formatDateTime(r.created_at)}
                </Link>
              </TD>
              <TD align="right" className="whitespace-nowrap font-medium">{formatMoney(r.amount)}</TD>
              <TD>
                <StatusBadge status={r.status} />
                {r.failure_reason ? <p className="mt-1 max-w-52 text-xs text-danger-fg">{r.failure_reason}</p> : null}
              </TD>
              <TD className="max-w-xs">{r.reason}</TD>
              <TD>
                <Link href={`/payments/refunds?payment_transaction_id=${r.payment_transaction_id}`} title="All refunds of this payment">
                  <code className="font-mono text-xs text-brand-soft-fg">{shortId(r.payment_transaction_id)}</code>
                </Link>
              </TD>
              <TD>
                <IdChip id={r.id} label="refund id" />
              </TD>
            </TR>
          ))
        )}
      </TBody>
    </TableCard>
  );
}
