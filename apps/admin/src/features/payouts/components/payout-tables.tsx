import Link from 'next/link';
import { Badge, StatusBadge } from '@/components/ui/feedback';
import { IdChip } from '@/components/ui/id';
import { TBody, TD, TH, THead, TR, TableCard, TableEmpty } from '@/components/ui/table';
import { ProviderLink } from '@/features/providers/components/provider-link';
import { formatDateTime, shortId } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import type { Payable, Payout, PayoutAccount, PayoutHold } from '../types';
import { HoldControl } from './hold-controls';

type Names = Map<string, string>;

export function PayoutsTable({ payouts, names }: { payouts: Payout[]; names: Names }) {
  return (
    <TableCard caption="Payouts">
      <THead>
        <tr>
          <TH stickyFirst>Created</TH>
          <TH>Provider</TH>
          <TH align="right">Amount</TH>
          <TH>Status</TH>
          <TH>UTR</TH>
          <TH>Attempts</TH>
          <TH>Payout</TH>
        </tr>
      </THead>
      <TBody>
        {payouts.length === 0 ? (
          <TableEmpty colSpan={7}>No payouts match these filters.</TableEmpty>
        ) : (
          payouts.map((p) => (
            <TR key={p.id}>
              <TD stickyFirst className="whitespace-nowrap">
                <Link href={`/payouts/${p.id}`} className="text-brand-soft-fg hover:underline">
                  {formatDateTime(p.created_at)}
                </Link>
              </TD>
              <TD>
                <ProviderLink id={p.provider_id} names={names} />
              </TD>
              <TD align="right" className="whitespace-nowrap font-medium">
                {formatMoney(p.amount)}
              </TD>
              <TD>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={p.status} />
                  {p.needs_review ? <Badge tone="danger">Needs review</Badge> : null}
                </div>
                {p.failure_reason ? <p className="mt-1 max-w-xs text-xs text-danger-fg">{p.failure_reason}</p> : null}
              </TD>
              <TD mono>{p.utr ?? '—'}</TD>
              <TD className="tabular-nums">{p.attempts}</TD>
              <TD>
                <IdChip id={p.id} label="payout id" />
              </TD>
            </TR>
          ))
        )}
      </TBody>
    </TableCard>
  );
}

export function PayablesTable({ payables, names }: { payables: Payable[]; names: Names }) {
  return (
    <TableCard caption="Provider payables">
      <THead>
        <tr>
          <TH stickyFirst>Created</TH>
          <TH>Provider</TH>
          <TH align="right">Net owed</TH>
          <TH align="right">Commission</TH>
          <TH>Status</TH>
          <TH>Eligible from</TH>
          <TH>Booking</TH>
          <TH>Payout</TH>
        </tr>
      </THead>
      <TBody>
        {payables.length === 0 ? (
          <TableEmpty colSpan={8}>No payables match these filters.</TableEmpty>
        ) : (
          payables.map((p) => (
            <TR key={p.id}>
              <TD stickyFirst className="whitespace-nowrap">{formatDateTime(p.created_at)}</TD>
              <TD>
                <ProviderLink id={p.provider_id} names={names} />
              </TD>
              <TD align="right" className="whitespace-nowrap font-medium">{formatMoney(p.net)}</TD>
              <TD align="right" className="whitespace-nowrap text-fg-muted">{formatMoney(p.commission)}</TD>
              <TD>
                <StatusBadge status={p.status} />
              </TD>
              <TD className="whitespace-nowrap">{formatDateTime(p.eligible_at)}</TD>
              <TD>
                <IdChip id={p.booking_id} label="booking id" />
              </TD>
              <TD>
                {p.payout_id ? (
                  <Link href={`/payouts/${p.payout_id}`} className="text-brand-soft-fg hover:underline">
                    <code className="font-mono text-xs">{shortId(p.payout_id)}</code>
                  </Link>
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </TD>
            </TR>
          ))
        )}
      </TBody>
    </TableCard>
  );
}

export function AccountsTable({ accounts, names }: { accounts: PayoutAccount[]; names: Names }) {
  return (
    <TableCard caption="Provider bank accounts (masked)">
      <THead>
        <tr>
          <TH stickyFirst>Provider</TH>
          <TH>Holder</TH>
          <TH>Account</TH>
          <TH>IFSC</TH>
          <TH>Status</TH>
          <TH>Verified</TH>
          <TH>Added</TH>
        </tr>
      </THead>
      <TBody>
        {accounts.length === 0 ? (
          <TableEmpty colSpan={7}>No bank accounts match these filters.</TableEmpty>
        ) : (
          accounts.map((a) => (
            <TR key={a.id}>
              <TD stickyFirst>
                <ProviderLink id={a.provider_id} names={names} />
              </TD>
              <TD>{a.holder_name}</TD>
              <TD mono>{a.account_number}</TD>
              <TD mono>{a.ifsc}</TD>
              <TD>
                <StatusBadge status={a.status} />
                {a.failure_reason ? <p className="mt-1 max-w-xs text-xs text-danger-fg">{a.failure_reason}</p> : null}
              </TD>
              <TD className="whitespace-nowrap">{formatDateTime(a.verified_at)}</TD>
              <TD className="whitespace-nowrap">{formatDateTime(a.created_at)}</TD>
            </TR>
          ))
        )}
      </TBody>
    </TableCard>
  );
}

export function HoldsTable({ holds, names }: { holds: PayoutHold[]; names: Names }) {
  return (
    <TableCard caption="Providers with payouts frozen">
      <THead>
        <tr>
          <TH stickyFirst>Provider</TH>
          <TH>Reason</TH>
          <TH>Placed by</TH>
          <TH>Since</TH>
          <TH>
            <span className="sr-only">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {holds.length === 0 ? (
          <TableEmpty colSpan={5}>No provider has frozen payouts.</TableEmpty>
        ) : (
          holds.map((h) => (
            <TR key={h.provider_id}>
              <TD stickyFirst>
                <ProviderLink id={h.provider_id} names={names} />
              </TD>
              <TD className="max-w-md">{h.reason}</TD>
              <TD>{h.automatic ? <Badge tone="warn">Automatic (repeated failures or contradiction)</Badge> : <Badge>An operator</Badge>}</TD>
              <TD className="whitespace-nowrap">{formatDateTime(h.since)}</TD>
              <TD className="text-right">
                <HoldControl providerId={h.provider_id} providerName={names.get(h.provider_id)} frozen />
              </TD>
            </TR>
          ))
        )}
      </TBody>
    </TableCard>
  );
}
