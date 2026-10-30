import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ValidationFailedError } from '../../../shared-kernel';
import { Public } from '../../identity-access';
import { SearchService } from '../application/search.service';

const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));
const bool = () => Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value));
const CODE = /^[a-z][a-z0-9_]{1,40}$/;

class SearchQueryDto {
  @num() @IsNumber() @Min(-90) @Max(90) lat!: number;
  @num() @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @num() @IsInt() @Min(100) @Max(50_000) radius_m?: number;
  @IsOptional() @IsString() @Matches(CODE) category?: string;
  @IsOptional() @IsString() @Matches(CODE) service_type?: string;
  @IsOptional() @num() @IsInt() @Min(0) max_price_minor?: number;
  @IsOptional() @num() @IsNumber() @Min(0) @Max(5) min_rating?: number;
  @IsOptional() @bool() @IsBoolean() open_now?: boolean;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'available_on must be YYYY-MM-DD' }) available_on?: string;
  @IsOptional() @IsIn(['distance', 'price', 'rating', 'next_available']) sort?: 'distance' | 'price' | 'rating' | 'next_available';
  @IsOptional() @num() @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsString() cursor?: string;
}

class MapQueryDto {
  /** minLng,minLat,maxLng,maxLat */
  @Matches(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, { message: 'bbox must be minLng,minLat,maxLng,maxLat' }) bbox!: string;
  @IsOptional() @IsString() @Matches(CODE) category?: string;
  @IsOptional() @IsString() @Matches(CODE) service_type?: string;
}

/** Public, unauthenticated discovery. The customer's coordinates are query parameters only — not stored, not logged. */
@ApiTags('search')
@Controller({ version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Public()
  @Get('search/providers')
  searchProviders(@Query() q: SearchQueryDto) {
    return this.search.searchProviders({
      lat: q.lat,
      lng: q.lng,
      radiusM: q.radius_m ?? 5000,
      category: q.category,
      serviceType: q.service_type,
      maxPriceMinor: q.max_price_minor,
      minRating: q.min_rating,
      openNow: q.open_now,
      availableOn: q.available_on,
      sort: q.sort ?? 'distance',
      limit: q.limit ?? 20,
      cursor: q.cursor,
    });
  }

  @Public()
  @Get('search/map')
  map(@Query() q: MapQueryDto) {
    const [minLng, minLat, maxLng, maxLat] = q.bbox.split(',').map(Number) as [number, number, number, number];
    if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 || Math.abs(minLng) > 180 || Math.abs(maxLng) > 180) {
      throw new ValidationFailedError('Invalid bounding box', { fields: { bbox: ['coordinates out of range'] } });
    }
    return this.search.map({ minLng, minLat, maxLng, maxLat }, { category: q.category, serviceType: q.service_type });
  }

  @Public()
  @Get('locations/:locationId')
  async profile(@Param('locationId', new ParseUUIDPipe()) locationId: string) {
    return { data: await this.search.profile(locationId) };
  }
}
