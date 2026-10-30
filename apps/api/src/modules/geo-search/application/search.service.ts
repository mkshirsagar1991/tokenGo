import { Injectable } from '@nestjs/common';
import { Money, NotFoundError, ValidationFailedError } from '../../../shared-kernel';
import { AvailabilityService, PolicyService } from '../../availability';
import { ListingRow, MarkerRow, SearchRepository, SortKey } from '../infrastructure/search.repository';

export interface SearchInput {
  lat: number;
  lng: number;
  radiusM: number;
  category?: string;
  serviceType?: string;
  maxPriceMinor?: number;
  minRating?: number;
  openNow?: boolean;
  availableOn?: string;
  sort: SortKey;
  limit: number;
  cursor?: string;
}

/** Candidates considered when a filter/sort needs per-location availability (documented trade-off, proposal §H.1). */
const ENRICH_CANDIDATES = 100;
const ENRICH_CONCURRENCY = 8;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const n = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
    if (Number.isInteger(n) && n >= 0 && n < 10_000) return n;
  } catch {
    /* fall through */
  }
  throw new ValidationFailedError('Invalid cursor', { fields: { cursor: ['is not valid'] } });
}
const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

/**
 * Provider discovery (requirements §8): geo + filters from PostGIS, then availability enrichment for the
 * page (open-now, next available slot) using the same slot engine booking will use.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly repo: SearchRepository,
    private readonly availability: AvailabilityService,
    private readonly policies: PolicyService,
  ) {}

  async searchProviders(q: SearchInput) {
    if ((q.availableOn || q.sort === 'next_available') && !q.serviceType) {
      throw new ValidationFailedError('service_type is required for availability filters/sorting', { fields: { service_type: ['required with available_on / sort=next_available'] } });
    }
    const offset = decodeCursor(q.cursor);
    const enrich = Boolean(q.openNow || q.availableOn || q.sort === 'next_available');
    const dbSort = q.sort === 'next_available' ? 'distance' : q.sort;
    const fetchLimit = enrich ? ENRICH_CANDIDATES : offset + q.limit + 1;

    const candidates = await this.repo.nearby(
      {
        lat: q.lat,
        lng: q.lng,
        radiusM: q.radiusM,
        category: q.category ?? null,
        serviceType: q.serviceType ?? null,
        maxPriceMinor: q.maxPriceMinor === undefined ? null : BigInt(q.maxPriceMinor),
        minRating: q.minRating ?? null,
      },
      dbSort,
      fetchLimit,
    );

    // Per-candidate enrichment (bounded concurrency): open-now + next available slot for the matched service.
    const wantNext = Boolean(q.serviceType);
    const enriched = await mapLimit(enrich ? candidates : candidates.slice(offset, offset + q.limit), ENRICH_CONCURRENCY, async (row) => {
      const [openNow, next] = await Promise.all([
        this.availability.isOpenNow(row.location_id),
        wantNext ? this.availability.nextAvailable(row.location_id, row.cheapest_service_id) : Promise.resolve(null),
      ]);
      let availableOnDate: boolean | null = null;
      if (q.availableOn) {
        const day = await this.availability.getSlots({ locationId: row.location_id, serviceId: row.cheapest_service_id, fromDate: q.availableOn, days: 1 });
        availableOnDate = day.slots.some((s) => s.localStart.startsWith(q.availableOn!));
      }
      return { row, openNow, nextAvailableAt: next ? new Date(next.startMs) : null, availableOnDate };
    });

    let results = enriched;
    if (q.openNow) results = results.filter((r) => r.openNow);
    if (q.availableOn) results = results.filter((r) => r.availableOnDate);
    if (q.sort === 'next_available') {
      results = [...results].sort((a, b) => (a.nextAvailableAt?.getTime() ?? Infinity) - (b.nextAvailableAt?.getTime() ?? Infinity));
    }
    const page = enrich ? results.slice(offset, offset + q.limit) : results;
    const hasMore = enrich ? results.length > offset + q.limit : candidates.length > offset + q.limit;

    return {
      data: page.map(({ row, openNow, nextAvailableAt }) => toListing(row, openNow, nextAvailableAt, wantNext)),
      meta: { count: page.length, next_cursor: hasMore ? encodeCursor(offset + q.limit) : null },
    };
  }

  async map(bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }, f: { category?: string; serviceType?: string }) {
    if (bbox.minLng >= bbox.maxLng || bbox.minLat >= bbox.maxLat) throw new ValidationFailedError('Invalid bounding box', { fields: { bbox: ['min must be less than max'] } });
    if (bbox.maxLat - bbox.minLat > 5 || bbox.maxLng - bbox.minLng > 5) throw new ValidationFailedError('Viewport too large', { fields: { bbox: ['zoom in: the viewport may span at most 5 degrees'] } });
    const rows = await this.repo.inBounds(bbox, { category: f.category ?? null, serviceType: f.serviceType ?? null }, 200);
    return { data: rows.map(toMarker), meta: { count: rows.length, truncated: rows.length === 200 } };
  }

  /** Public profile of one location: everything the customer needs to decide, before choosing a slot. */
  async profile(locationId: string) {
    const loc = await this.repo.findListing(locationId);
    if (!loc) throw new NotFoundError('Location');
    const [services, staff, hours, openNow, policy] = await Promise.all([
      this.repo.listServices(locationId),
      this.repo.listStaff(locationId),
      this.availability.weeklyHours(locationId),
      this.availability.isOpenNow(locationId),
      this.policies.resolve(loc.provider_id),
    ]);
    const dest = `${loc.latitude},${loc.longitude}`;
    return {
      location_id: loc.location_id,
      provider_id: loc.provider_id,
      name: loc.provider_name,
      location_name: loc.location_name,
      description: loc.provider_description,
      address: { line1: loc.address_line1, line2: loc.address_line2, city: loc.city, state: loc.state, postal_code: loc.postal_code, country: loc.country },
      latitude: loc.latitude,
      longitude: loc.longitude,
      timezone: loc.timezone,
      rating: { average: loc.rating_avg === null ? null : Number(loc.rating_avg), count: loc.rating_count },
      open_now: openNow,
      hours,
      services: services.map((s) => ({
        id: s.provider_service_id,
        name: s.name,
        description: s.description,
        category: s.category_code,
        service_type: s.service_type_code,
        price: Money.of(BigInt(s.price_minor), s.currency).toJSON(),
        duration_min: s.duration_min,
      })),
      staff: staff.map((s) => ({ id: s.resource_id, display_name: s.display_name, service_ids: s.skills })), // null = can perform every service
      booking_rules: { min_lead_time_min: policy.minLeadTimeMin, max_advance_days: policy.maxAdvanceDays, slot_granularity_min: policy.slotGranularityMin },
      cancellation_policy: null, // configurable policies arrive with the booking/refund phase
      // Directions use the map app's own deep link, with the BUSINESS location as destination — the
      // customer's position never leaves their device (requirements §8).
      directions: {
        google_maps: `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
        apple_maps: `https://maps.apple.com/?daddr=${dest}`,
      },
    };
  }
}

function toListing(row: ListingRow, openNow: boolean, nextAvailableAt: Date | null, nextRequested: boolean) {
  return {
    location_id: row.location_id,
    provider_id: row.provider_id,
    name: row.provider_name,
    location_name: row.location_name,
    address: { line1: row.address_line1, line2: row.address_line2, city: row.city, state: row.state, postal_code: row.postal_code },
    latitude: row.latitude,
    longitude: row.longitude,
    distance_m: Math.round(row.distance_m),
    timezone: row.timezone,
    rating: { average: row.rating_avg === null ? null : Number(row.rating_avg), count: row.rating_count },
    price_from: Money.of(BigInt(row.min_price_minor), row.currency).toJSON(),
    matching_services: row.matching_services,
    open_now: openNow,
    // null = nothing in the search horizon; omitted entirely when no service was specified
    ...(nextRequested ? { next_available_at: nextAvailableAt ? nextAvailableAt.toISOString() : null } : {}),
  };
}

function toMarker(m: MarkerRow) {
  return {
    location_id: m.location_id,
    name: m.provider_name,
    latitude: m.latitude,
    longitude: m.longitude,
    price_from: Money.of(BigInt(m.min_price_minor), m.currency).toJSON(),
  };
}
