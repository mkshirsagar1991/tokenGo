import type { Metadata } from 'next';
import { Alert, InlineProblem, ProblemView } from '@/components/ui/feedback';
import { FilterBar, TextField } from '@/components/ui/form';
import { Card, PageHeader, StatTile } from '@/components/ui/layout';
import { TBody, TD, TH, THead, TR, TableCard } from '@/components/ui/table';
import { BarChart } from '@/features/reports/components/bar-chart';
import type { DailyRow, ReportOverview } from '@/features/reports/types';
import { param, type SearchParams } from '@/lib/api-types';
import { addDays, humanize, istDateString } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { serverApi } from '@/lib/server/api';
import { serverNow } from '@/lib/server/clock';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Reports' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const today = istDateString(serverNow());
  const to = param(sp, 'to') && DATE.test(param(sp, 'to')!) ? param(sp, 'to')! : today;
  const from = param(sp, 'from') && DATE.test(param(sp, 'from')!) ? param(sp, 'from')! : addDays(to, -29);
  const [overview, daily] = await Promise.all([serverApi<ReportOverview>('/admin/reports/overview', { query: { from, to } }), serverApi<DailyRow[]>('/admin/reports/daily', { query: { from, to } })]);

  const preset = (days: number, label: string) => (
    <Link key={label} href={`/reports?from=${addDays(today, -(days - 1))}&to=${today}`} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-fg-muted hover:text-fg">
      {label}
    </Link>
  );

  return (
    <>
      <PageHeader title="Reports" description="Operational figures computed from the system of record at the moment you open the page (nothing cached or estimated). Days are calendar days in Indian Standard Time, end date included; at most 366 days." />
      <FilterBar action="/reports">
        <TextField label="From" name="from" type="date" defaultValue={from} wrapperClassName="w-44" required />
        <TextField label="To" name="to" type="date" defaultValue={to} wrapperClassName="w-44" required />
      </FilterBar>
      <p className="mb-5 flex items-center gap-2 text-sm text-fg-subtle">
        Presets: {preset(7, 'Last 7 days')}
        {preset(30, 'Last 30 days')}
        {preset(90, 'Last 90 days')}
      </p>

      {!overview.ok ? (
        <ProblemView problem={overview.problem} permission="report:read" what="reports" retryHref={`/reports?from=${from}&to=${to}`} />
      ) : (
        <div className="space-y-8">
          <section aria-labelledby="money-h">
            <h2 id="money-h" className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg-subtle">Money</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatTile label="Gross booking value (closed bookings)" value={formatMoney(overview.data.money.gross_booking_value_closed)} />
              <StatTile label="Platform commission" value={formatMoney(overview.data.money.platform_commission)} />
              <StatTile label="Top-ups succeeded" value={formatMoney(overview.data.money.topups_succeeded)} hint={`${overview.data.money.topups_succeeded.count} payment(s)`} />
              <StatTile label="Refunds succeeded" value={formatMoney(overview.data.money.refunds_succeeded)} hint={`${overview.data.money.refunds_succeeded.count} refund(s)`} />
              <StatTile label="Payouts paid" value={formatMoney(overview.data.money.payouts_paid)} hint={`${overview.data.money.payouts_paid.count} payout(s)`} />
            </div>
          </section>

          <section aria-labelledby="bookings-h">
            <h2 id="bookings-h" className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg-subtle">Bookings</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <StatTile label="Requested" value={overview.data.bookings.requested} />
              <StatTile label="Confirmed" value={overview.data.bookings.confirmed} />
              <StatTile label="Completed" value={overview.data.bookings.completed} />
              <StatTile label="Closed" value={overview.data.bookings.closed} />
              <StatTile label="Distinct customers" value={overview.data.bookings.distinct_customers} />
            </div>
            <Card title="Bookings created in the period, by their current status" className="mt-4">
              {Object.keys(overview.data.bookings.created_by_status).length === 0 ? (
                <p className="text-sm text-fg-muted">No bookings were created in this period.</p>
              ) : (
                <ul className="flex flex-wrap gap-2 text-sm">
                  {Object.entries(overview.data.bookings.created_by_status).map(([s, n]) => (
                    <li key={s} className="rounded-full bg-surface-2 px-3 py-1">
                      {humanize(s)} <strong className="tabular-nums text-fg">{n}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          <section aria-labelledby="accounts-h">
            <h2 id="accounts-h" className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg-subtle">Accounts</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile label="New users" value={overview.data.accounts.new_users} />
              <StatTile label="New providers" value={overview.data.accounts.new_providers} />
              <StatTile label="Providers approved" value={overview.data.accounts.providers_approved} />
            </div>
          </section>

          <section aria-labelledby="daily-h">
            <h2 id="daily-h" className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg-subtle">Day by day</h2>
            {daily.ok ? (
              <div className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <BarChart title="Gross booking value closed" money data={daily.data.map((d) => ({ label: d.day, value: d.gross_booking_value_closed.amount_minor }))} />
                  <BarChart title="Top-ups succeeded" money data={daily.data.map((d) => ({ label: d.day, value: d.topups_succeeded.amount_minor }))} color="var(--success-fg)" />
                  <BarChart title="Bookings created" data={daily.data.map((d) => ({ label: d.day, value: d.bookings_created }))} color="var(--info-fg)" />
                </div>
                <TableCard caption="Daily figures">
                  <THead>
                    <tr>
                      <TH stickyFirst>Day</TH>
                      <TH align="right">Bookings created</TH>
                      <TH align="right">Bookings closed</TH>
                      <TH align="right">Gross value closed</TH>
                      <TH align="right">Top-ups</TH>
                      <TH align="right">Refunds</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {[...daily.data].reverse().map((d) => (
                      <TR key={d.day}>
                        <TD stickyFirst className="whitespace-nowrap">{d.day}</TD>
                        <TD align="right">{d.bookings_created}</TD>
                        <TD align="right">{d.bookings_closed}</TD>
                        <TD align="right">{formatMoney(d.gross_booking_value_closed)}</TD>
                        <TD align="right">{formatMoney(d.topups_succeeded)}</TD>
                        <TD align="right">{formatMoney(d.refunds_succeeded)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </TableCard>
              </div>
            ) : (
              <InlineProblem problem={daily.problem} permission="report:read" />
            )}
          </section>
          <Alert tone="info">Figures cover bookings, payments and payouts only as far as the API reports them. Gross value counts bookings that reached CLOSED within the period.</Alert>
        </div>
      )}
    </>
  );
}
