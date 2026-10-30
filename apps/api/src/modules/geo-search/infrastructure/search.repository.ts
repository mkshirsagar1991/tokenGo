import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { UnitOfWork } from '../../../shared-kernel';

export type SortKey = 'distance' | 'price' | 'rating' | 'next_available';

export interface SearchFilters {
  lat: number;
  lng: number;
  radiusM: number;
  category: string | null;
  serviceType: string | null;
  maxPriceMinor: bigint | null;
  minRating: number | null;
}

export interface ListingRow {
  location_id: string;
  provider_id: string;
  provider_name: string;
  location_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  latitude: number;
  longitude: number;
  distance_m: number;
  timezone: string;
  rating_avg: string | null;
  rating_count: number;
  min_price_minor: string;
  currency: string;
  matching_services: number;
  cheapest_service_id: string;
}

export interface MarkerRow {
  location_id: string;
  provider_name: string;
  latitude: number;
  longitude: number;
  min_price_minor: string;
  currency: string;
}

// ORDER BY is chosen from this WHITELIST (never interpolated from input).
const ORDER: Record<Exclude<SortKey, 'next_available'>, string> = {
  distance: 'distance_m ASC, l.location_id',
  price: 'agg.min_price_minor ASC, distance_m ASC, l.location_id',
  rating: 'l.rating_avg DESC NULLS LAST, distance_m ASC, l.location_id',
};

/**
 * All discovery reads go through the `search.*` views (docs §D.2 rule 3): they state exactly what is
 * publicly discoverable (APPROVED provider, ACTIVE location, enabled category, active service).
 * Coordinates are bound parameters used for this query only — they are never stored or logged.
 */
@Injectable()
export class SearchRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.db<unknown>();
  }

  /** Candidate locations near a point, nearest-first by default. Spatial filtering uses the GiST index. */
  async nearby(f: SearchFilters, sort: Exclude<SortKey, 'next_available'>, limit: number): Promise<ListingRow[]> {
    const result = await sql<ListingRow>`
      WITH me AS (SELECT ST_SetSRID(ST_MakePoint(${f.lng}, ${f.lat}), 4326)::geography AS g)
      SELECT l.location_id, l.provider_id, l.provider_name, l.location_name,
             l.address_line1, l.address_line2, l.city, l.state, l.postal_code,
             ST_Y(l.geog::geometry) AS latitude, ST_X(l.geog::geometry) AS longitude,
             ST_Distance(l.geog, me.g) AS distance_m,
             l.timezone, l.rating_avg, l.rating_count,
             agg.min_price_minor, agg.currency, agg.matching_services, agg.cheapest_service_id
        FROM search.location_listing l
       CROSS JOIN me
        JOIN LATERAL (
              SELECT min(s.price_minor) AS min_price_minor,
                     min(s.currency)    AS currency,
                     count(*)::int      AS matching_services,
                     (array_agg(s.provider_service_id ORDER BY s.price_minor, s.provider_service_id))[1] AS cheapest_service_id
                FROM search.location_service s
               WHERE s.location_id = l.location_id
                 AND (${f.category}::text IS NULL OR s.category_code = ${f.category}::text)
                 AND (${f.serviceType}::text IS NULL OR s.service_type_code = ${f.serviceType}::text)
                 AND (${f.maxPriceMinor?.toString() ?? null}::bigint IS NULL OR s.price_minor <= ${f.maxPriceMinor?.toString() ?? null}::bigint)
             ) agg ON agg.matching_services > 0
       WHERE ST_DWithin(l.geog, me.g, ${f.radiusM})
         AND (${f.minRating}::numeric IS NULL OR l.rating_avg >= ${f.minRating}::numeric)
       ORDER BY ${sql.raw(ORDER[sort])}
       LIMIT ${limit}`.execute(this.db);
    return result.rows;
  }

  /** Lightweight pins for a map viewport. `&&` (bounding-box overlap) uses the GiST index. */
  async inBounds(b: { minLng: number; minLat: number; maxLng: number; maxLat: number }, f: Pick<SearchFilters, 'category' | 'serviceType'>, limit: number): Promise<MarkerRow[]> {
    const result = await sql<MarkerRow>`
      SELECT l.location_id, l.provider_name,
             ST_Y(l.geog::geometry) AS latitude, ST_X(l.geog::geometry) AS longitude,
             agg.min_price_minor, agg.currency
        FROM search.location_listing l
        JOIN LATERAL (
              SELECT min(s.price_minor) AS min_price_minor, min(s.currency) AS currency, count(*) AS n
                FROM search.location_service s
               WHERE s.location_id = l.location_id
                 AND (${f.category}::text IS NULL OR s.category_code = ${f.category}::text)
                 AND (${f.serviceType}::text IS NULL OR s.service_type_code = ${f.serviceType}::text)
             ) agg ON agg.n > 0
       WHERE l.geog && ST_MakeEnvelope(${b.minLng}, ${b.minLat}, ${b.maxLng}, ${b.maxLat}, 4326)::geography
       ORDER BY l.location_id
       LIMIT ${limit}`.execute(this.db);
    return result.rows;
  }

  // --- public profile ------------------------------------------------------------------------------------------
  async findListing(locationId: string) {
    const r = await sql<{
      location_id: string;
      provider_id: string;
      provider_name: string;
      provider_description: string | null;
      location_name: string;
      address_line1: string;
      address_line2: string | null;
      city: string;
      state: string;
      postal_code: string;
      country: string;
      latitude: number;
      longitude: number;
      timezone: string;
      rating_avg: string | null;
      rating_count: number;
    }>`SELECT location_id, provider_id, provider_name, provider_description, location_name,
              address_line1, address_line2, city, state, postal_code, country,
              ST_Y(geog::geometry) AS latitude, ST_X(geog::geometry) AS longitude,
              timezone, rating_avg, rating_count
         FROM search.location_listing WHERE location_id = ${locationId}`.execute(this.db);
    return r.rows[0];
  }

  async listServices(locationId: string) {
    const r = await sql<{
      provider_service_id: string;
      name: string;
      description: string | null;
      price_minor: string;
      currency: string;
      duration_min: number;
      buffer_min: number;
      service_type_code: string;
      category_code: string;
    }>`SELECT provider_service_id, name, description, price_minor, currency, duration_min, buffer_min, service_type_code, category_code
         FROM search.location_service WHERE location_id = ${locationId}
        ORDER BY category_code, service_type_code, price_minor, provider_service_id`.execute(this.db);
    return r.rows;
  }

  async listStaff(locationId: string) {
    const r = await sql<{ resource_id: string; display_name: string; skills: string[] | null }>`
      SELECT lr.resource_id, lr.display_name,
             array_agg(rs.provider_service_id) FILTER (WHERE rs.provider_service_id IS NOT NULL) AS skills
        FROM search.location_resource lr
        LEFT JOIN search.resource_skill rs ON rs.resource_id = lr.resource_id
       WHERE lr.location_id = ${locationId}
       GROUP BY lr.resource_id, lr.display_name
       ORDER BY lr.display_name, lr.resource_id`.execute(this.db);
    return r.rows;
  }
}
