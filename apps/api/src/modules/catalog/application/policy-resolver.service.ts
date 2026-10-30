import { Injectable } from '@nestjs/common';
import { LedgerInvariantFallback } from '../domain/errors';
import type { CancellationSnapshot, CommissionSnapshot } from '../domain/pricing-rules';
import { CatalogRepository } from '../infrastructure/catalog.repository';

/**
 * Resolves the commission rule and cancellation policy IN FORCE at a given instant (most specific scope
 * wins, effective-dated). Booking snapshots the result so that later rule changes never rewrite history
 * (requirements §19/§20).
 */
@Injectable()
export class PolicyResolverService {
  constructor(private readonly repo: CatalogRepository) {}

  async resolveCommission(input: { at: Date; providerServiceId: string; providerId: string; serviceTypeId: string; categoryId: string }): Promise<CommissionSnapshot> {
    const rule = await this.repo.findCommissionRuleFor(input.at, input);
    if (!rule) throw new LedgerInvariantFallback('No commission rule is in force (the platform default is missing)');
    return {
      ruleId: rule.id,
      ruleVersion: rule.version,
      kind: rule.kind,
      percentBps: rule.percent_bps,
      fixedMinor: rule.fixed_minor === null ? null : BigInt(rule.fixed_minor),
    };
  }

  async resolveCancellationPolicy(input: { at: Date; providerId: string; categoryId: string }): Promise<CancellationSnapshot> {
    const policy = await this.repo.findCancellationPolicyFor(input.at, input);
    if (!policy) throw new LedgerInvariantFallback('No cancellation policy is in force (the platform default is missing)');
    return {
      policyId: policy.id,
      policyVersion: policy.version,
      name: policy.name,
      tiers: policy.tiers.map((t) => ({ minHoursBefore: t.min_hours_before, refundBps: t.refund_bps })),
      noShowRefundBps: policy.no_show_refund_bps,
      providerCancelRefundBps: policy.provider_cancel_refund_bps,
    };
  }
}
