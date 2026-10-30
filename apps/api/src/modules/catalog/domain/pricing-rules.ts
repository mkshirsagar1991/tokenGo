import { Money } from '../../../shared-kernel';

/** The commission rule in force for a booking, as snapshotted into it (requirements §19). */
export interface CommissionSnapshot {
  ruleId: string | null;
  ruleVersion: number | null;
  kind: 'PERCENT' | 'FIXED';
  percentBps: number | null;
  fixedMinor: bigint | null;
}

export interface RefundTier {
  minHoursBefore: number;
  refundBps: number;
}

export interface CancellationSnapshot {
  policyId: string | null;
  policyVersion: number | null;
  name: string;
  tiers: RefundTier[];
  noShowRefundBps: number;
  providerCancelRefundBps: number;
}

/**
 * One commission rule for a booking that holds several services. When every service resolves to the SAME rule (the normal case:
 * rules are usually set per platform, category or business) that rule is kept exactly, rule id and version included. When they
 * differ (a per-service override on one of them) the booking snapshots a PERCENT rule worth exactly what the separate rules
 * would have taken, rounded to the nearest basis point, with no rule id because it is no single rule.
 */
export function combineCommission(lines: { rule: CommissionSnapshot; amount: Money }[]): CommissionSnapshot {
  const first = lines[0];
  if (!first) throw new RangeError('No services to combine commission for');
  const same = (a: CommissionSnapshot, b: CommissionSnapshot) =>
    a.kind === b.kind && a.ruleId === b.ruleId && a.ruleVersion === b.ruleVersion && a.percentBps === b.percentBps && a.fixedMinor === b.fixedMinor;
  if (lines.every((l) => same(l.rule, first.rule))) return first.rule;

  let gross = Money.zero(first.amount.currency);
  let commission = Money.zero(first.amount.currency);
  for (const l of lines) {
    gross = gross.add(l.amount);
    commission = commission.add(splitCommission(l.rule, l.amount).commission);
  }
  if (gross.isZero()) return first.rule;
  const bps = Number((commission.minor * 10_000n + gross.minor / 2n) / gross.minor);
  return { ruleId: null, ruleVersion: null, kind: 'PERCENT', percentBps: Math.min(10_000, bps), fixedMinor: null };
}

/**
 * Splits an amount into platform commission and provider net so that `commission + net === amount` EXACTLY.
 *  - PERCENT: basis points, rounded half-up; the rounding residual stays on the provider side.
 *  - FIXED: a flat fee, capped at the amount (a ₹50 fee on a ₹30 amount takes ₹30, never more than exists).
 * Commission basis (decision J.7): the amount actually settled to the provider side — callers pass the
 * post-refund, pre-tax amount.
 */
export function splitCommission(rule: CommissionSnapshot, amount: Money): { commission: Money; net: Money } {
  if (amount.isNegative()) throw new RangeError('Cannot compute commission on a negative amount');
  if (rule.kind === 'PERCENT') {
    if (rule.percentBps === null) throw new RangeError('PERCENT rule without percentBps');
    return amount.splitCommissionBps(rule.percentBps);
  }
  if (rule.fixedMinor === null) throw new RangeError('FIXED rule without fixedMinor');
  const commission = Money.of(rule.fixedMinor, amount.currency).min(amount);
  return { commission, net: amount.subtract(commission) };
}

/**
 * Refund (in basis points) for a CUSTOMER cancellation `hoursBefore` hours ahead of the start. The tier with
 * the largest `minHoursBefore` that is still <= hoursBefore applies; with no applicable tier nothing is refunded.
 */
export function customerRefundBps(tiers: RefundTier[], hoursBefore: number): number {
  const applicable = tiers.filter((t) => t.minHoursBefore <= hoursBefore).sort((a, b) => b.minHoursBefore - a.minHoursBefore)[0];
  return applicable?.refundBps ?? 0;
}

export type CancellationKind = 'CUSTOMER' | 'PROVIDER' | 'NO_SHOW';

export function refundBpsFor(policy: CancellationSnapshot, kind: CancellationKind, hoursBefore: number): number {
  switch (kind) {
    case 'PROVIDER':
      return policy.providerCancelRefundBps;
    case 'NO_SHOW':
      return policy.noShowRefundBps;
    case 'CUSTOMER':
      return customerRefundBps(policy.tiers, hoursBefore);
  }
}

/** The refund portion and the retained portion (the cancellation fee) of a held amount. They always sum to it. */
export function splitRefund(amount: Money, refundBps: number): { refund: Money; retained: Money } {
  const refund = amount.percentBps(refundBps);
  return { refund, retained: amount.subtract(refund) };
}
