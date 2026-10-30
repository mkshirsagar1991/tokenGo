import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Money, UnitOfWork, ValidationFailedError } from '../../../shared-kernel';

const CURRENCY = 'INR';
const MAX_DAYS = 366;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const inr = (minor: string | number | bigint | null | undefined) => Money.of(BigInt(minor ?? 0), CURRENCY).toJSON();

export interface ReportRange {
  from: string; // YYYY-MM-DD, inclusive, in `tz`
  to: string; // YYYY-MM-DD, inclusive, in `tz`
  tz: string;
}

/**
 * Operational reports for administrators and finance (requirements §30). Every figure is computed from the system of record
 * (bookings, ledger, payments, settlement) at query time — nothing is cached or estimated — and money stays in integer minor
 * units. Days are calendar days in `tz` (default Asia/Kolkata), `to` inclusive.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly uow: UnitOfWork) {}

  async overview(range: ReportRange) {
    const { lo, hi } = await this.bounds(range);
    const db = this.uow.db<unknown>();
    const one = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(db)).rows[0]!;

    const byStatus = (
      await sql<{ status: string; n: string }>`SELECT status, count(*)::text AS n FROM booking.bookings WHERE created_at >= ${lo} AND created_at < ${hi} GROUP BY status`.execute(db)
    ).rows;
    const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));

    const flow = await one(sql<{ requested: string; confirmed: string; completed: string; closed: string; customers: string }>`
      SELECT count(*) FILTER (WHERE requested_at >= ${lo} AND requested_at < ${hi})::text AS requested,
             count(*) FILTER (WHERE confirmed_at >= ${lo} AND confirmed_at < ${hi})::text AS confirmed,
             count(*) FILTER (WHERE completed_at >= ${lo} AND completed_at < ${hi})::text AS completed,
             count(*) FILTER (WHERE closed_at >= ${lo} AND closed_at < ${hi})::text AS closed,
             count(DISTINCT customer_id) FILTER (WHERE created_at >= ${lo} AND created_at < ${hi})::text AS customers
        FROM booking.bookings`);

    const gmv = await one(sql<{ v: string }>`
      SELECT coalesce(sum(f.gross_minor), 0)::text AS v
        FROM booking.bookings b JOIN booking.booking_financials f ON f.booking_id = b.id
       WHERE b.status = 'CLOSED' AND b.closed_at >= ${lo} AND b.closed_at < ${hi}`);

    const commission = await one(sql<{ v: string }>`
      SELECT (coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'CREDIT'), 0) - coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT'), 0))::text AS v
        FROM ledger.entries e JOIN ledger.accounts a ON a.id = e.account_id
       WHERE a.account_type = 'PLATFORM_COMMISSION' AND e.created_at >= ${lo} AND e.created_at < ${hi}`);

    const topups = await one(sql<{ v: string; n: string }>`
      SELECT coalesce(sum(amount_minor), 0)::text AS v, count(*)::text AS n
        FROM payments.payment_intents WHERE status = 'SUCCEEDED' AND succeeded_at >= ${lo} AND succeeded_at < ${hi}`);

    const refunds = await one(sql<{ v: string; n: string }>`
      SELECT coalesce(sum(amount_minor), 0)::text AS v, count(*)::text AS n
        FROM payments.refunds WHERE status = 'SUCCEEDED' AND updated_at >= ${lo} AND updated_at < ${hi}`);

    const payouts = await one(sql<{ v: string; n: string }>`
      SELECT coalesce(sum(amount_minor), 0)::text AS v, count(*)::text AS n
        FROM settlement.payouts WHERE status = 'PAID' AND completed_at >= ${lo} AND completed_at < ${hi}`);

    const accounts = await one(sql<{ users: string; providers: string; approved: string }>`
      SELECT (SELECT count(*) FROM identity.users WHERE created_at >= ${lo} AND created_at < ${hi})::text AS users,
             (SELECT count(*) FROM provider.providers WHERE created_at >= ${lo} AND created_at < ${hi} AND deleted_at IS NULL)::text AS providers,
             (SELECT count(*) FROM provider.providers WHERE status = 'APPROVED' AND decided_at >= ${lo} AND decided_at < ${hi})::text AS approved`);

    return {
      range: { from: range.from, to: range.to, timezone: range.tz },
      bookings: {
        created_by_status: statusCounts,
        requested: Number(flow.requested),
        confirmed: Number(flow.confirmed),
        completed: Number(flow.completed),
        closed: Number(flow.closed),
        distinct_customers: Number(flow.customers),
      },
      money: {
        gross_booking_value_closed: inr(gmv.v),
        platform_commission: inr(commission.v),
        topups_succeeded: { ...inr(topups.v), count: Number(topups.n) },
        refunds_succeeded: { ...inr(refunds.v), count: Number(refunds.n) },
        payouts_paid: { ...inr(payouts.v), count: Number(payouts.n) },
      },
      accounts: { new_users: Number(accounts.users), new_providers: Number(accounts.providers), providers_approved: Number(accounts.approved) },
    };
  }

  async daily(range: ReportRange) {
    const { lo, hi } = await this.bounds(range);
    const tz = range.tz;
    const db = this.uow.db<unknown>();
    const rows = (
      await sql<{ day: string; created: string; closed: string; gmv: string; topups: string; refunds: string }>`
        WITH days AS (
          SELECT d::date AS day FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS d
        ),
        created AS (
          SELECT (created_at AT TIME ZONE ${tz})::date AS day, count(*) AS n FROM booking.bookings WHERE created_at >= ${lo} AND created_at < ${hi} GROUP BY 1
        ),
        closed AS (
          SELECT (b.closed_at AT TIME ZONE ${tz})::date AS day, count(*) AS n, sum(f.gross_minor) AS gmv
            FROM booking.bookings b JOIN booking.booking_financials f ON f.booking_id = b.id
           WHERE b.status = 'CLOSED' AND b.closed_at >= ${lo} AND b.closed_at < ${hi} GROUP BY 1
        ),
        topups AS (
          SELECT (succeeded_at AT TIME ZONE ${tz})::date AS day, sum(amount_minor) AS v FROM payments.payment_intents
           WHERE status = 'SUCCEEDED' AND succeeded_at >= ${lo} AND succeeded_at < ${hi} GROUP BY 1
        ),
        refunds AS (
          SELECT (updated_at AT TIME ZONE ${tz})::date AS day, sum(amount_minor) AS v FROM payments.refunds
           WHERE status = 'SUCCEEDED' AND updated_at >= ${lo} AND updated_at < ${hi} GROUP BY 1
        )
        SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
               coalesce(created.n, 0)::text AS created, coalesce(closed.n, 0)::text AS closed, coalesce(closed.gmv, 0)::text AS gmv,
               coalesce(topups.v, 0)::text AS topups, coalesce(refunds.v, 0)::text AS refunds
          FROM days
          LEFT JOIN created USING (day) LEFT JOIN closed USING (day) LEFT JOIN topups USING (day) LEFT JOIN refunds USING (day)
         ORDER BY days.day`.execute(db)
    ).rows;
    return {
      range: { from: range.from, to: range.to, timezone: tz },
      data: rows.map((r) => ({
        day: r.day,
        bookings_created: Number(r.created),
        bookings_closed: Number(r.closed),
        gross_booking_value_closed: inr(r.gmv),
        topups_succeeded: inr(r.topups),
        refunds_succeeded: inr(r.refunds),
      })),
    };
  }

  /** Validates the range and turns it into [lo, hi) instants for the timezone. */
  private async bounds(range: ReportRange): Promise<{ lo: Date; hi: Date }> {
    if (!DATE.test(range.from) || !DATE.test(range.to)) throw new ValidationFailedError('from and to must be dates like 2026-10-01');
    const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
    if (!Number.isFinite(days) || days < 1) throw new ValidationFailedError('to must not be before from');
    if (days > MAX_DAYS) throw new ValidationFailedError(`A report covers at most ${MAX_DAYS} days`);
    const db = this.uow.db<unknown>();
    const tz = (await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${range.tz}) AS ok`.execute(db)).rows[0]!.ok;
    if (!tz) throw new ValidationFailedError(`Unknown time zone "${range.tz}"`);
    const r = (
      await sql<{ lo: Date; hi: Date }>`SELECT (${range.from}::date)::timestamp AT TIME ZONE ${range.tz} AS lo, ((${range.to}::date + 1))::timestamp AT TIME ZONE ${range.tz} AS hi`.execute(db)
    ).rows[0]!;
    return r;
  }
}
