import { Injectable } from '@nestjs/common';
import { Money } from '../../../shared-kernel';
import { MAX_SERVICES_PER_BOOKING, ServiceBundle, bundleServices } from '../domain/service-bundle';
import { CatalogRepository } from '../infrastructure/catalog.repository';

export interface BookableService {
  id: string;
  providerId: string;
  name: string;
  /** Trusted price: always read from here, never from a client (requirements §9). */
  price: Money;
  durationMin: number;
  bufferMin: number;
  /** Bumped on price/duration/buffer change; bookings snapshot it. */
  version: number;
  serviceTypeId: string;
  categoryId: string;
  bookingFlowType: string;
  /** Offered right now: service active AND its type AND its category are enabled. */
  offerable: boolean;
}

/** Several services of one provider, combined into the one appointment a booking reserves. */
export type BookableBundle = ServiceBundle<BookableService>;

/**
 * Read facade over the catalogue for availability/booking/search. Prices and durations are trusted ONLY
 * when they come through here.
 */
@Injectable()
export class CatalogReadService {
  constructor(private readonly repo: CatalogRepository) {}

  async getBookableService(serviceId: string): Promise<BookableService | undefined> {
    const s = await this.repo.findBookableService(serviceId);
    if (!s) return undefined;
    return {
      id: s.id,
      providerId: s.provider_id,
      name: s.name,
      price: Money.of(BigInt(s.price_minor), s.currency),
      durationMin: s.duration_min,
      bufferMin: s.buffer_min,
      version: s.version,
      serviceTypeId: s.service_type_id,
      categoryId: s.category_id,
      bookingFlowType: s.booking_flow_type,
      offerable: s.is_active && s.service_type_active && s.category_active,
    };
  }

  /**
   * Loads and combines the chosen services into one appointment (price = sum, time = sum). Undefined when any of them does not
   * exist, they belong to different businesses, there are none, or there are more than [MAX_SERVICES_PER_BOOKING]: to the caller
   * all of those are simply "no such service". Whether each is currently OFFERED is left to the caller, as for a single service.
   */
  async getBookableBundle(serviceIds: string[]): Promise<BookableBundle | undefined> {
    const ids = [...new Set(serviceIds)];
    if (ids.length === 0 || ids.length > MAX_SERVICES_PER_BOOKING) return undefined;
    const found = await Promise.all(ids.map((id) => this.getBookableService(id)));
    if (found.some((s) => !s)) return undefined;
    const result = bundleServices(found as BookableService[]);
    return result.ok ? result.bundle : undefined;
  }

  /**
   * Which of these resources can perform ALL of the services? (One person does the whole visit, one service after the other.)
   * Same rule as for one service: a resource with no skill rows is a generalist, one with skills is limited to them.
   */
  async filterResourcesBySkills(serviceIds: string[], resourceIds: string[]): Promise<string[]> {
    const skills = await this.repo.skillsByResource(resourceIds);
    return resourceIds.filter((id) => {
      const limited = skills.get(id);
      return !limited || serviceIds.every((s) => limited.has(s));
    });
  }

  /**
   * Which of these resources can perform the service? A resource with NO skill rows is a generalist
   * (eligible for everything its provider offers); a resource with skills is limited to them.
   */
  async filterResourcesBySkill(serviceId: string, resourceIds: string[]): Promise<string[]> {
    const skills = await this.repo.skillsByResource(resourceIds);
    return resourceIds.filter((id) => {
      const limited = skills.get(id);
      return !limited || limited.has(serviceId);
    });
  }
}
