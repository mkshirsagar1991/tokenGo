import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ProviderAccessService } from '../../provider-management';
import { LedgerService, PLATFORM_ACCOUNTS } from '../../wallet-ledger';
import { APP_CONFIG, AppConfig, Clock, Money, NotFoundError, UnitOfWork } from '../../../shared-kernel';
import type { PayableRow, PayableStatus, PayoutRow, PayoutStatus, SettlementDb } from '../infrastructure/db-types';
import { PayoutAccountService, PayoutAccountView } from './payout-account.service';
import { PayoutService, SkipReason } from './payout.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inr = (minor: bigint | string | number) => Money.of(BigInt(minor), 'INR').toJSON();

export interface EarningsView {
  /** Earned but not yet payable (the payout delay has not elapsed). */
  waiting: ReturnType<typeof inr>;
  /** Payable by bank now (subject to `payout.blocker`). */
  eligible: ReturnType<typeof inr>;
  /** Already in a bank transfer that has not completed. */
  in_payout: ReturnType<typeof inr>;
  /** Paid into the bank account. */
  paid_total: ReturnType<typeof inr>;
  next_eligible_at: string | null;
  payout: { blocker: SkipReason | null; minimum: ReturnType<typeof inr>; account: PayoutAccountView | null };
}

/** Read side of settlement: what a provider has earned, been paid and is waiting for; what finance sees across providers. */
@Injectable()
export class SettlementQueryService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly access: ProviderAccessService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutService,
    private readonly accounts: PayoutAccountService,
  ) {}

  private get db() {
    return this.uow.db<SettlementDb>();
  }

  // ===== provider-facing ==============================================================================================
  async providerEarnings(userId: string, providerId: string): Promise<EarningsView> {
    await this.access.require(userId, 'earnings:read', providerId);
    return this.earnings(providerId);
  }

  async earnings(providerId: string): Promise<EarningsView> {
    const now = this.clock.now();
    const row = (
      await sql<{ waiting: string; eligible: string; in_payout: string; paid: string; next_eligible_at: Date | null }>`
        SELECT coalesce(sum(net_minor) FILTER (WHERE status = 'ACCRUED' AND eligible_at >  ${now}), 0)::text AS waiting,
               coalesce(sum(net_minor) FILTER (WHERE status = 'ACCRUED' AND eligible_at <= ${now}), 0)::text AS eligible,
               coalesce(sum(net_minor) FILTER (WHERE status = 'IN_PAYOUT'), 0)::text                          AS in_payout,
               coalesce(sum(net_minor) FILTER (WHERE status = 'PAID'), 0)::text                               AS paid,
               min(eligible_at) FILTER (WHERE status = 'ACCRUED' AND eligible_at > ${now})                    AS next_eligible_at
          FROM settlement.provider_payables WHERE provider_id = ${providerId}`.execute(this.db)
    ).rows[0]!;
    const { reason } = await this.payouts.blockerFor(providerId, BigInt(row.eligible));
    return {
      waiting: inr(row.waiting),
      eligible: inr(row.eligible),
      in_payout: inr(row.in_payout),
      paid_total: inr(row.paid),
      next_eligible_at: row.next_eligible_at ? row.next_eligible_at.toISOString() : null,
      payout: { blocker: reason, minimum: inr(this.config.payouts.minMinor), account: await this.accounts.current(providerId) },
    };
  }

  async providerPayables(userId: string, providerId: string, opts: { status?: PayableStatus; limit: number; cursor?: string }) {
    await this.access.require(userId, 'earnings:read', providerId);
    return this.listPayables({ ...opts, providerId });
  }

  async providerPayouts(userId: string, providerId: string, opts: { limit: number; cursor?: string }) {
    await this.access.require(userId, 'earnings:read', providerId);
    return this.listPayouts({ ...opts, providerId }, false);
  }

  async providerPayout(userId: string, providerId: string, payoutId: string) {
    await this.access.require(userId, 'earnings:read', providerId);
    return this.payoutDetail(payoutId, providerId, false);
  }

  // ===== shared / finance =============================================================================================
  async listPayables(opts: { providerId?: string; status?: PayableStatus; limit: number; cursor?: string }) {
    let q = this.db.selectFrom('settlement.provider_payables').selectAll().orderBy('id', 'desc').limit(opts.limit + 1);
    if (opts.providerId) q = q.where('provider_id', '=', opts.providerId);
    if (opts.status) q = q.where('status', '=', opts.status);
    if (opts.cursor) q = q.where('id', '<', opts.cursor);
    const rows = await q.execute();
    const page = rows.slice(0, opts.limit);
    return { data: page.map((r) => this.payableView(r)), nextCursor: rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  async listPayouts(opts: { providerId?: string; status?: PayoutStatus; needsReview?: boolean; limit: number; cursor?: string }, admin: boolean) {
    let q = this.db.selectFrom('settlement.payouts').selectAll().orderBy('id', 'desc').limit(opts.limit + 1);
    if (opts.providerId) q = q.where('provider_id', '=', opts.providerId);
    if (opts.status) q = q.where('status', '=', opts.status);
    if (opts.needsReview) q = q.where('needs_review', '=', true);
    if (opts.cursor) q = q.where('id', '<', opts.cursor);
    const rows = await q.execute();
    const page = rows.slice(0, opts.limit);
    return { data: page.map((r) => this.payoutView(r, admin)), nextCursor: rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  async payoutDetail(payoutId: string, providerId: string | undefined, admin: boolean) {
    if (!UUID_RE.test(payoutId)) throw new NotFoundError('Payout');
    let q = this.db.selectFrom('settlement.payouts').selectAll().where('id', '=', payoutId);
    if (providerId) q = q.where('provider_id', '=', providerId); // another provider's payout is "not found", never "forbidden"
    const row = await q.executeTakeFirst();
    if (!row) throw new NotFoundError('Payout');
    const items = await this.db
      .selectFrom('settlement.payout_items as i')
      .innerJoin('settlement.provider_payables as p', 'p.id', 'i.payable_id')
      .select(['p.id', 'p.booking_id', 'p.net_minor'])
      .where('i.payout_id', '=', payoutId)
      .orderBy('p.id')
      .execute();
    return { ...this.payoutView(row, admin), items: items.map((i) => ({ payable_id: i.id, booking_id: i.booking_id, net: inr(i.net_minor) })) };
  }

  async listHolds() {
    const rows = await this.db.selectFrom('settlement.payout_holds').selectAll().orderBy('created_at', 'desc').execute();
    return rows.map((h) => ({ provider_id: h.provider_id, reason: h.reason, automatic: h.automatic, since: h.created_at.toISOString() }));
  }

  // ===== integrity ====================================================================================================
  /**
   * Do the settlement tables agree with the ledger? (1) what each provider is owed in `provider_payables` equals the ledger's payable
   * balance, (2) the money "in transit" in PAYOUT_CLEARING equals the open payouts, (3) every payout's payables add up to the payout,
   * (4) payable and payout states agree. Read-only: it reports, it never repairs. Payables are recorded from outbox events, so a
   * difference while such events are still pending is expected and reported as `pending_payable_events`.
   */
  async integrity(): Promise<{ ok: boolean; violations: string[]; pending_payable_events: number }> {
    const violations: string[] = [];

    const accrued = await this.db.selectFrom('settlement.provider_payables').select(['provider_id', (eb) => eb.fn.sum<string>('net_minor').as('total')]).where('status', '=', 'ACCRUED').groupBy('provider_id').execute();
    const owed = new Map(accrued.map((a) => [a.provider_id, BigInt(a.total)]));
    const ledgerBalances = await this.ledger.listProviderPayableBalances();
    const missingFromLedgerList = [...owed.keys()].filter((id) => !ledgerBalances.has(id));
    const extra = await this.ledger.getProviderPayableBalances(missingFromLedgerList);
    for (const id of new Set([...owed.keys(), ...ledgerBalances.keys()])) {
      const inLedger = ledgerBalances.get(id) ?? extra.get(id) ?? 0n;
      const inRows = owed.get(id) ?? 0n;
      if (inLedger !== inRows) violations.push(`provider ${id}: the ledger says ${inLedger} is payable but the payable rows add up to ${inRows}`);
    }

    const openTotal = await this.db.selectFrom('settlement.payouts').select((eb) => eb.fn.sum<string>('amount_minor').as('total')).where('status', 'in', ['RESERVED', 'SUBMITTED']).executeTakeFirst();
    const clearing = await this.ledger.getPlatformAccountBalance(PLATFORM_ACCOUNTS.PAYOUT_CLEARING);
    if (clearing !== BigInt(openTotal?.total ?? '0')) violations.push(`PAYOUT_CLEARING holds ${clearing} but the open payouts add up to ${openTotal?.total ?? '0'}`);

    const mismatched = await sql<{ id: string; amount: string; items: string; status: string }>`
      SELECT po.id, po.amount_minor::text AS amount, coalesce(sum(p.net_minor), 0)::text AS items, po.status
        FROM settlement.payouts po
        LEFT JOIN settlement.payout_items i ON i.payout_id = po.id
        LEFT JOIN settlement.provider_payables p ON p.id = i.payable_id
       WHERE po.status <> 'FAILED'
       GROUP BY po.id HAVING po.amount_minor <> coalesce(sum(p.net_minor), 0)`.execute(this.db);
    for (const r of mismatched.rows) violations.push(`payout ${r.id} (${r.status}) is for ${r.amount} but its payables add up to ${r.items}`);

    const stateMismatch = await sql<{ id: string; payable_status: string; payout_status: string }>`
      SELECT p.id, p.status AS payable_status, po.status AS payout_status
        FROM settlement.provider_payables p JOIN settlement.payouts po ON po.id = p.payout_id
       WHERE NOT ((p.status = 'IN_PAYOUT' AND po.status IN ('RESERVED', 'SUBMITTED')) OR (p.status = 'PAID' AND po.status = 'PAID'))`.execute(this.db);
    for (const r of stateMismatch.rows) violations.push(`payable ${r.id} is ${r.payable_status} but its payout is ${r.payout_status}`);

    const pending = await sql<{ n: string }>`SELECT count(*)::text AS n FROM platform.outbox_events WHERE event_type = 'ledger.provider_payable_credited' AND status IN ('PENDING', 'PROCESSING')`.execute(this.db);
    return { ok: violations.length === 0, violations, pending_payable_events: Number(pending.rows[0]?.n ?? 0) };
  }

  // ===== views ========================================================================================================
  private payableView(r: PayableRow) {
    return {
      id: r.id,
      provider_id: r.provider_id,
      booking_id: r.booking_id,
      net: inr(r.net_minor),
      commission: inr(r.commission_minor),
      status: r.status,
      eligible_at: r.eligible_at.toISOString(),
      payout_id: r.payout_id,
      created_at: r.created_at.toISOString(),
    };
  }

  /** Providers see state and amounts; operational detail (attempts, raw errors, provider ids) is for finance only. */
  private payoutView(r: PayoutRow, admin: boolean) {
    return {
      id: r.id,
      amount: inr(r.amount_minor),
      status: r.status,
      utr: r.utr,
      failure_reason: r.failure_reason,
      created_at: r.created_at.toISOString(),
      submitted_at: r.submitted_at ? r.submitted_at.toISOString() : null,
      completed_at: r.completed_at ? r.completed_at.toISOString() : null,
      ...(admin ? { provider_id: r.provider_id, provider: r.provider_name, provider_payout_id: r.provider_payout_id, reference: r.provider_reference, attempts: r.attempts, last_error: r.last_error, needs_review: r.needs_review } : {}),
    };
  }
}
