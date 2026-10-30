import { Injectable } from '@nestjs/common';
import { Clock, ConflictError, NotFoundError, OutboxService, UnitOfWork } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { AuthorizationService } from '../../identity-access';
import { SettingsService } from '../../platform';
import { DocumentService } from './document.service';
import { ProviderAction, ProviderStatus, nextProviderStatus } from '../domain/provider-status';
import { ProviderRepository, ProviderRow } from '../infrastructure/provider.repository';
import { ProviderAccessService } from './provider-access.service';

export function toProviderView(p: ProviderRow, opts: { includeDecision: boolean }) {
  return {
    id: p.id,
    display_name: p.display_name,
    description: p.description,
    status: p.status,
    submitted_at: p.submitted_at,
    decided_at: p.decided_at,
    // The review reason is shown to the owner (so they can fix and resubmit) and to administrators.
    decision_reason: opts.includeDecision ? p.decision_reason : undefined,
    version: p.version,
    created_at: p.created_at,
  };
}

@Injectable()
export class ProviderService {
  constructor(
    private readonly repo: ProviderRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly authz: AuthorizationService,
    private readonly access: ProviderAccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
    private readonly documents: DocumentService,
  ) {}

  async register(userId: string, input: { displayName: string; description: string | null }) {
    await this.authz.require(userId, 'provider:register');
    return this.uow.run(async () => {
      const provider = await this.repo.insertProvider({ ownerUserId: userId, displayName: input.displayName, description: input.description });
      // The registrant becomes OWNER of exactly this provider (PROVIDER-scoped role).
      await this.authz.grantRole(userId, 'PROVIDER_OWNER', { type: 'PROVIDER', id: provider.id }, userId);
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.registered',
        entityType: 'provider',
        entityId: provider.id,
        after: { status: provider.status, display_name: provider.display_name },
      });
      await this.outbox.publish({
        type: 'provider.registered',
        aggregateType: 'provider',
        aggregateId: provider.id,
        payload: { provider_id: provider.id, owner_user_id: userId },
      });
      return toProviderView(provider, { includeDecision: true });
    });
  }

  async listMine(userId: string) {
    const rows = await this.repo.listProvidersByOwner(userId);
    return rows.map((p) => toProviderView(p, { includeDecision: true }));
  }

  async get(userId: string, providerId: string) {
    await this.access.requireRead(userId, providerId);
    const provider = await this.repo.findProvider(providerId);
    if (!provider) throw new ConflictError('PROVIDER_GONE', 'Provider disappeared');
    return toProviderView(provider, { includeDecision: true });
  }

  async update(userId: string, providerId: string, patch: { displayName?: string; description?: string | null }) {
    await this.access.require(userId, 'provider:update', providerId);
    return this.uow.run(async () => {
      const before = await this.repo.findProvider(providerId, { forUpdate: true });
      if (!before) throw new ConflictError('PROVIDER_GONE', 'Provider disappeared');
      if (before.status === 'SUSPENDED') {
        throw new ConflictError('PROVIDER_SUSPENDED', 'A suspended provider cannot be edited; contact support');
      }
      const after = await this.repo.updateProfile(providerId, patch);
      if (!after) throw new ConflictError('PROVIDER_GONE', 'Provider disappeared');
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.updated',
        entityType: 'provider',
        entityId: providerId,
        before: { display_name: before.display_name, description: before.description },
        after: { display_name: after.display_name, description: after.description },
      });
      return toProviderView(after, { includeDecision: true });
    });
  }

  /** Owner submits the business for verification. A business with no location cannot be verified. */
  async submit(userId: string, providerId: string) {
    await this.access.require(userId, 'provider:update', providerId);
    return this.transition(userId, providerId, 'SUBMIT', {
      precondition: async () => {
        if ((await this.repo.countActiveLocations(providerId)) < 1) {
          throw new ConflictError('PROVIDER_INCOMPLETE', 'Add at least one location before submitting for verification', {
            missing: ['location'],
          });
        }
        if ((await this.settings.get<boolean>('providers.documents_required')) && (await this.documents.count(providerId)) < 1) {
          throw new ConflictError('PROVIDER_INCOMPLETE', 'Upload at least one verification document before submitting for review', { missing: ['document'] });
        }
      },
    });
  }

  /** Administrative decisions (permission enforced by the caller's route guard). */
  decide(adminUserId: string, providerId: string, action: Exclude<ProviderAction, 'SUBMIT'>, reason?: string) {
    return this.transition(adminUserId, providerId, action, { reason });
  }

  private transition(
    actorId: string,
    providerId: string,
    action: ProviderAction,
    opts: { reason?: string; precondition?: () => Promise<void> },
  ) {
    return this.uow.run(async () => {
      const current = await this.repo.findProvider(providerId, { forUpdate: true });
      if (!current) throw new NotFoundError('Provider');
      const next: ProviderStatus = nextProviderStatus(current.status, action);
      await opts.precondition?.();

      const isDecision = action !== 'SUBMIT';
      const updated = await this.repo.transitionStatus(providerId, current.status, next, {
        now: this.clock.now(),
        submitted: action === 'SUBMIT',
        decidedBy: isDecision ? actorId : undefined,
        reason: opts.reason ?? null,
      });
      if (!updated) throw new ConflictError('CONCURRENT_MODIFICATION', 'The provider was changed by someone else; reload and retry');

      await this.audit.record({
        actorType: 'USER',
        actorId,
        action: `provider.${action.toLowerCase()}`,
        entityType: 'provider',
        entityId: providerId,
        before: { status: current.status },
        after: { status: next },
        metadata: opts.reason ? { reason: opts.reason } : {},
      });
      // Announced in the SAME transaction: a rolled-back approval never notifies anyone.
      await this.outbox.publish({
        type: `provider.${action.toLowerCase()}`,
        aggregateType: 'provider',
        aggregateId: providerId,
        payload: { provider_id: providerId, owner_user_id: updated.owner_user_id, from: current.status, to: next, reason: opts.reason ?? null },
      });
      return toProviderView(updated, { includeDecision: true });
    });
  }

  // --- administration reads ----------------------------------------------------------------------------
  async adminList(filter: { status?: ProviderStatus; cursor?: string; limit: number }) {
    const rows = await this.repo.listProviders({ status: filter.status, afterId: filter.cursor, limit: filter.limit + 1 });
    const page = rows.slice(0, filter.limit);
    return {
      data: page.map((p) => toProviderView(p, { includeDecision: true })),
      meta: { next_cursor: rows.length > filter.limit ? (page[page.length - 1]?.id ?? null) : null },
    };
  }

  async adminGet(providerId: string) {
    const provider = await this.repo.findProvider(providerId);
    if (!provider) throw new NotFoundError('Provider');
    return toProviderView(provider, { includeDecision: true });
  }
}
