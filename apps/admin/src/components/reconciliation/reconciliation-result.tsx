import { Alert, Badge, StatusBadge } from '@/components/ui/feedback';
import { Card, DescriptionList } from '@/components/ui/layout';
import { TBody, TD, TH, THead, TR, TableCard, TableEmpty } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import type { ReconciliationResult } from './types';

const HELP: Record<string, string> = {
  MISSING_INTERNAL: 'The provider took/paid money we have NO record of. Investigate first.',
  MISSING_EXTERNAL: 'We recorded something the provider does not show (possibly timing).',
  AMOUNT_MISMATCH: 'Both exist but the amounts disagree (quarantined payments appear here; they were never credited).',
  STATUS_MISMATCH: 'Both exist but they disagree about the state.',
  REFUND_MISMATCH: 'The provider shows MORE refunded than we ever requested: a refund made outside the system.',
};

export function ReconciliationResultView({ result }: { result: ReconciliationResult }) {
  return (
    <div className="space-y-4">
      <Card title="Result" actions={<Badge tone={result.exceptions === 0 ? 'success' : 'danger'}>{result.exceptions === 0 ? 'No exceptions' : `${result.exceptions} exception${result.exceptions === 1 ? '' : 's'}`}</Badge>}>
        <DescriptionList
          columns={3}
          items={[
            { label: 'Provider', value: <code className="font-mono">{result.provider}</code> },
            { label: 'Period', value: `${formatDateTime(result.period_from)} → ${formatDateTime(result.period_to)}` },
            { label: 'Matched', value: result.matched },
            { label: 'Run id', value: <code className="font-mono text-xs">{result.id}</code> },
          ]}
        />
        <Alert tone="info" className="mt-4">
          Reconciliation reports; it never repairs. Each exception is a question for a person with the provider&apos;s dashboard.
        </Alert>
      </Card>
      <TableCard caption="Reconciliation exceptions">
        <THead>
          <tr>
            <TH stickyFirst>Exception</TH>
            <TH>Reference</TH>
            <TH align="right">Expected (ours)</TH>
            <TH align="right">Actual (provider)</TH>
            <TH>Detail</TH>
          </tr>
        </THead>
        <TBody>
          {result.records.length === 0 ? (
            <TableEmpty colSpan={5}>Everything in this period matched.</TableEmpty>
          ) : (
            result.records.map((r, i) => (
              <TR key={`${r.status}-${i}`}>
                <TD stickyFirst>
                  <StatusBadge status={r.status} />
                  <p className="mt-1 max-w-48 text-xs text-fg-subtle">{HELP[r.status]}</p>
                </TD>
                <TD mono className="break-all">{r.provider_payment_id ?? r.reference ?? r.payment_transaction_id ?? r.payout_id ?? '—'}</TD>
                <TD align="right" className="whitespace-nowrap">{formatMoney(r.expected)}</TD>
                <TD align="right" className="whitespace-nowrap">{formatMoney(r.actual)}</TD>
                <TD className="max-w-sm">{r.detail || '—'}</TD>
              </TR>
            ))
          )}
        </TBody>
      </TableCard>
    </div>
  );
}
