import { Injectable } from '@nestjs/common';
import { Clock, ConflictError, Money, NotFoundError, UnitOfWork, ValidationFailedError } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { ProviderAccessService } from '../../provider-management';
import { CatalogRepository } from '../infrastructure/catalog.repository';

type ServiceRow = NonNullable<Awaited<ReturnType<CatalogRepository['findProviderService']>>>;

/** Money crosses the API as `{ amount_minor, currency }` — never a float, never a pre-formatted string. */
export function toProviderServiceView(s: ServiceRow) {
  return {
    id: s.id,
    provider_id: s.provider_id,
    service_type_id: s.service_type_id,
    name: s.name,
    description: s.description,
    price: Money.of(BigInt(s.price_minor), s.currency).toJSON(),
    duration_min: s.duration_min,
    buffer_min: s.buffer_min,
    is_active: s.is_active,
    attributes: s.attributes,
    version: s.version,
  };
}

const MAX_PRICE_MINOR = 100_000_000n; // ₹10,00,000 — a sanity ceiling against fat-finger/overflow input

function parsePrice(priceMinor: number, currency: string): bigint {
  let money: Money;
  try {
    money = Money.of(priceMinor, currency);
  } catch {
    throw new ValidationFailedError('Invalid price', { fields: { price_minor: ['must be a non-negative integer in minor units (e.g. 20000 = ₹200.00)'] } });
  }
  if (money.isNegative() || money.minor > MAX_PRICE_MINOR) {
    throw new ValidationFailedError('Invalid price', { fields: { price_minor: [`must be between 0 and ${MAX_PRICE_MINOR}`] } });
  }
  return money.minor;
}

/**
 * The provider's service catalogue. These records are the ONLY trusted source of price and duration
 * (requirements §9): bookings read from here and snapshot the `version`; clients never supply totals.
 */
@Injectable()
export class ProviderCatalogService {
  constructor(
    private readonly repo: CatalogRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly access: ProviderAccessService,
    private readonly audit: AuditService,
  ) {}

  private async requireManage(userId: string, providerId: string): Promise<void> {
    const provider = await this.access.require(userId, 'service:manage', providerId);
    if (provider.status === 'SUSPENDED') throw new ConflictError('PROVIDER_SUSPENDED', 'A suspended provider cannot change its catalogue');
  }

  async create(
    userId: string,
    providerId: string,
    input: {
      serviceTypeId: string;
      name: string;
      description: string | null;
      priceMinor: number;
      currency: string;
      durationMin: number;
      bufferMin: number;
      attributes: Record<string, unknown>;
    },
  ) {
    await this.requireManage(userId, providerId);
    const priceMinor = parsePrice(input.priceMinor, input.currency);

    return this.uow.run(async () => {
      const type = await this.repo.findServiceTypeWithCategory(input.serviceTypeId);
      if (!type) throw new ValidationFailedError('Unknown service type', { fields: { service_type_id: ['does not exist'] } });
      // Only enabled verticals/service types can be offered (requirements §5: only Salon active initially).
      if (!type.is_active || !type.category_active) {
        throw new ConflictError('CATEGORY_NOT_ENABLED', 'This service type is not currently available on the platform');
      }
      const created = await this.repo.insertProviderService({
        providerId,
        serviceTypeId: input.serviceTypeId,
        name: input.name,
        description: input.description,
        priceMinor,
        currency: input.currency,
        durationMin: input.durationMin,
        bufferMin: input.bufferMin,
        attributes: input.attributes,
      });
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'catalog.provider_service_created',
        entityType: 'provider_service',
        entityId: created.id,
        after: toProviderServiceView(created),
      });
      return toProviderServiceView(created);
    });
  }

  async list(userId: string, providerId: string) {
    await this.access.requireAtAnyScope(userId, 'service:read', providerId);
    return (await this.repo.listProviderServices(providerId)).map(toProviderServiceView);
  }

  async update(
    userId: string,
    providerId: string,
    serviceId: string,
    patch: {
      name?: string;
      description?: string | null;
      priceMinor?: number;
      durationMin?: number;
      bufferMin?: number;
      isActive?: boolean;
      attributes?: Record<string, unknown>;
    },
  ) {
    await this.requireManage(userId, providerId);
    return this.uow.run(async () => {
      const before = await this.repo.findProviderService(providerId, serviceId, { forUpdate: true });
      if (!before) throw new NotFoundError('Service');

      const priceMinor = patch.priceMinor === undefined ? undefined : parsePrice(patch.priceMinor, before.currency);
      // Version bumps whenever something a booking snapshot depends on changes.
      const bump =
        (priceMinor !== undefined && priceMinor !== BigInt(before.price_minor)) ||
        (patch.durationMin !== undefined && patch.durationMin !== before.duration_min) ||
        (patch.bufferMin !== undefined && patch.bufferMin !== before.buffer_min);

      const after = await this.repo.updateProviderService(providerId, serviceId, { ...patch, priceMinor }, bump);
      if (!after) throw new NotFoundError('Service');
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'catalog.provider_service_updated',
        entityType: 'provider_service',
        entityId: serviceId,
        before: toProviderServiceView(before),
        after: toProviderServiceView(after),
      });
      return toProviderServiceView(after);
    });
  }

  async remove(userId: string, providerId: string, serviceId: string): Promise<void> {
    await this.requireManage(userId, providerId);
    await this.uow.run(async () => {
      if (!(await this.repo.softDeleteProviderService(providerId, serviceId, this.clock.now()))) throw new NotFoundError('Service');
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'catalog.provider_service_deleted',
        entityType: 'provider_service',
        entityId: serviceId,
        metadata: { provider_id: providerId },
      });
    });
  }
}
