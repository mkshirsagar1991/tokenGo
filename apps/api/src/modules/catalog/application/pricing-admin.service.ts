import { Injectable } from '@nestjs/common';
import { Clock, ConflictError, Money, NotFoundError, PG_EXCLUSION_VIOLATION, UnitOfWork, ValidationFailedError, pgErrorCode } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { ProviderDirectoryService } from '../../provider-management';
import { CatalogRepository } from '../infrastructure/catalog.repository';

type CommissionScope = 'PLATFORM' | 'CATEGORY' | 'SERVICE_TYPE' | 'PROVIDER' | 'PROVIDER_SERVICE';
type CancellationScope = 'PLATFORM' | 'CATEGORY' | 'PROVIDER';

/**
 * Administration of commission rules and cancellation policies. Rules are VERSIONED, never edited: a change
 * closes the current version at `effective_from` and opens the next. Changes may not be retroactive (they
 * cannot take effect in the past), so a booking's snapshot is always consistent with what was in force.
 * (Maker-checker approval for these sensitive changes is a tracked follow-up; every change is audited.)
 */
@Injectable()
export class PricingAdminService {
  constructor(
    private readonly repo: CatalogRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly directory: ProviderDirectoryService,
    private readonly audit: AuditService,
  ) {}

  private async assertScopeExists(type: CommissionScope | CancellationScope, id: string | undefined): Promise<void> {
    if ((type === 'PLATFORM') !== (id === undefined)) {
      throw new ValidationFailedError('Invalid scope', { fields: { scope_id: [type === 'PLATFORM' ? 'must be omitted for PLATFORM' : 'is required for this scope'] } });
    }
    if (id === undefined) return;
    const exists =
      type === 'CATEGORY' ? await this.repo.categoryExists(id)
      : type === 'SERVICE_TYPE' ? await this.repo.serviceTypeExists(id)
      : type === 'PROVIDER' ? await this.directory.providerExists(id)
      : await this.repo.providerServiceExists(id);
    if (!exists) throw new NotFoundError('Scope');
  }

  private effectiveFrom(requested: string | undefined): Date {
    const now = this.clock.now();
    const at = requested ? new Date(requested) : now;
    if (Number.isNaN(at.getTime())) throw new ValidationFailedError('Invalid effective_from', { fields: { effective_from: ['must be an ISO-8601 instant'] } });
    // 1 s of slack for clock jitter; anything earlier would rewrite what was in force.
    if (at.getTime() < now.getTime() - 1000) throw new ValidationFailedError('Changes cannot be retroactive', { fields: { effective_from: ['must not be in the past'] } });
    return at.getTime() < now.getTime() ? now : at;
  }

  // --- commission -------------------------------------------------------------------------------------------------
  async listCommissionRules() {
    return (await this.repo.listCommissionRules()).map((r) => ({
      id: r.id,
      scope_type: r.scope_type,
      scope_id: r.scope_id,
      kind: r.kind,
      percent_bps: r.percent_bps,
      fixed: r.fixed_minor === null ? null : Money.of(BigInt(r.fixed_minor), r.currency).toJSON(),
      effective_from: r.effective_from,
      effective_to: r.effective_to,
      version: r.version,
    }));
  }

  async createCommissionRule(adminId: string, input: { scopeType: CommissionScope; scopeId?: string; kind: 'PERCENT' | 'FIXED'; percentBps?: number; fixedMinor?: number; effectiveFrom?: string }) {
    await this.assertScopeExists(input.scopeType, input.scopeId);
    if (input.kind === 'PERCENT' && (input.percentBps === undefined || input.fixedMinor !== undefined)) throw new ValidationFailedError('A PERCENT rule needs percent_bps only');
    if (input.kind === 'FIXED' && (input.fixedMinor === undefined || input.percentBps !== undefined)) throw new ValidationFailedError('A FIXED rule needs fixed_minor only');
    const from = this.effectiveFrom(input.effectiveFrom);

    return this.uow.run(async () => {
      const open = await this.repo.findOpenCommissionRule(input.scopeType, input.scopeId ?? null, from);
      if (open && open.effective_from.getTime() >= from.getTime()) throw new ConflictError('RULE_VERSION_CONFLICT', 'A later version of this rule already exists');
      if (open) await this.repo.closeCommissionRule(open.id, from);
      try {
        const created = await this.repo.insertCommissionRule({
          scopeType: input.scopeType,
          scopeId: input.scopeId ?? null,
          kind: input.kind,
          percentBps: input.percentBps ?? null,
          fixedMinor: input.fixedMinor === undefined ? null : BigInt(input.fixedMinor),
          effectiveFrom: from,
          version: (open?.version ?? 0) + 1,
          createdBy: adminId,
        });
        await this.audit.record({
          actorType: 'USER',
          actorId: adminId,
          action: 'pricing.commission_rule_versioned',
          entityType: 'commission_rule',
          entityId: created.id,
          before: open ? { rule_id: open.id, version: open.version } : null,
          after: { scope_type: input.scopeType, kind: input.kind, percent_bps: input.percentBps ?? null, fixed_minor: input.fixedMinor ?? null, version: created.version, effective_from: from.toISOString() },
        });
        return { id: created.id, version: created.version, effective_from: from };
      } catch (err) {
        if (pgErrorCode(err) === PG_EXCLUSION_VIOLATION) throw new ConflictError('RULE_VERSION_CONFLICT', 'The new version overlaps an existing one');
        throw err;
      }
    });
  }

  // --- cancellation -------------------------------------------------------------------------------------------------
  async listCancellationPolicies() {
    const policies = await this.repo.listCancellationPolicies();
    return Promise.all(
      policies.map(async (p) => ({
        id: p.id,
        name: p.name,
        scope_type: p.scope_type,
        scope_id: p.scope_id,
        no_show_refund_bps: p.no_show_refund_bps,
        provider_cancel_refund_bps: p.provider_cancel_refund_bps,
        effective_from: p.effective_from,
        effective_to: p.effective_to,
        version: p.version,
      })),
    );
  }

  async createCancellationPolicy(
    adminId: string,
    input: { name: string; scopeType: CancellationScope; scopeId?: string; tiers: { minHoursBefore: number; refundBps: number }[]; noShowRefundBps?: number; providerCancelRefundBps?: number; effectiveFrom?: string },
  ) {
    await this.assertScopeExists(input.scopeType, input.scopeId);
    const tiers = [...input.tiers].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
    const fields: string[] = [];
    if (!tiers.some((t) => t.minHoursBefore === 0)) fields.push('a tier with min_hours_before = 0 is required (what applies at the last minute)');
    if (new Set(tiers.map((t) => t.minHoursBefore)).size !== tiers.length) fields.push('min_hours_before values must be unique');
    // More notice must never be penalised: refund is non-increasing as the start approaches.
    for (let i = 1; i < tiers.length; i++) if (tiers[i]!.refundBps > tiers[i - 1]!.refundBps) fields.push('refund must not increase as the appointment gets closer');
    if (fields.length) throw new ValidationFailedError('Invalid refund tiers', { fields: { tiers: fields } });
    const from = this.effectiveFrom(input.effectiveFrom);

    return this.uow.run(async () => {
      const open = await this.repo.findOpenCancellationPolicy(input.scopeType, input.scopeId ?? null, from);
      if (open) await this.repo.closeCancellationPolicy(open.id, from);
      try {
        const created = await this.repo.insertCancellationPolicy({
          name: input.name,
          scopeType: input.scopeType,
          scopeId: input.scopeId ?? null,
          noShowRefundBps: input.noShowRefundBps ?? 0,
          providerCancelRefundBps: input.providerCancelRefundBps ?? 10000,
          effectiveFrom: from,
          version: (open?.version ?? 0) + 1,
          createdBy: adminId,
          tiers,
        });
        await this.audit.record({
          actorType: 'USER',
          actorId: adminId,
          action: 'pricing.cancellation_policy_versioned',
          entityType: 'cancellation_policy',
          entityId: created.id,
          before: open ? { policy_id: open.id, version: open.version } : null,
          after: { name: input.name, scope_type: input.scopeType, tiers, version: created.version, effective_from: from.toISOString() },
        });
        return { id: created.id, version: created.version, effective_from: from };
      } catch (err) {
        if (pgErrorCode(err) === PG_EXCLUSION_VIOLATION) throw new ConflictError('POLICY_VERSION_CONFLICT', 'The new version overlaps an existing one');
        throw err;
      }
    });
  }
}
