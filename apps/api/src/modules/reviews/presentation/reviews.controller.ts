import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Actor, CurrentActor, Public, RequirePlatformPermission } from '../../identity-access';
import { ReviewService } from '../application/review.service';

const uuid = () => new ParseUUIDPipe();
const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

class ReviewDto {
  @IsDefined() rating!: unknown;
  @IsOptional() comment?: unknown;
}
class ReviewUpdateDto {
  @IsOptional() rating?: unknown;
  @IsOptional() comment?: unknown;
}
class ReplyDto {
  @IsDefined() text!: unknown;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
class PageDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(50) limit?: number;
}
class AdminListDto extends PageDto {
  @IsOptional() @IsIn(['PUBLISHED', 'HIDDEN']) status?: string;
  @IsOptional() @IsUUID() provider_id?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(5) rating?: number;
}

/** A customer reviews a booking of their own once it has been settled. */
@ApiTags('reviews')
@Controller({ path: 'appointments', version: '1' })
export class CustomerReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Post(':id/review')
  async create(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: ReviewDto) {
    return { data: await this.reviews.create(actor.userId, id, dto) };
  }

  @Put(':id/review')
  @HttpCode(200)
  async update(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: ReviewUpdateDto) {
    return { data: await this.reviews.update(actor.userId, id, dto) };
  }

  @Get(':id/review')
  async mine(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.reviews.getMine(actor.userId, id) };
  }
}

/** What anyone can read about a location: the published reviews and the rating summary. */
@ApiTags('reviews')
@Controller({ path: 'locations', version: '1' })
export class PublicReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Public()
  @Get(':locationId/reviews')
  list(@Param('locationId', uuid()) locationId: string, @Query() q: PageDto) {
    return this.reviews.listForLocation(locationId, { cursor: q.cursor, limit: q.limit ?? 20 });
  }
}

/** The business reads and answers the reviews of its own locations. */
@ApiTags('reviews')
@Controller({ path: 'providers/:providerId/reviews', version: '1' })
export class ProviderReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Query() q: PageDto) {
    return this.reviews.listForProvider(actor.userId, providerId, { cursor: q.cursor, limit: q.limit ?? 20 });
  }

  @Post(':reviewId/reply')
  @HttpCode(200)
  async reply(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Param('reviewId', uuid()) reviewId: string, @Body() dto: ReplyDto) {
    return { data: await this.reviews.reply(actor.userId, providerId, reviewId, dto.text) };
  }
}

/** Moderation. Hiding removes a review from the public rating and listing; both directions are audited with a reason. */
@ApiTags('admin')
@Controller({ path: 'admin/reviews', version: '1' })
export class AdminReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Get()
  @RequirePlatformPermission('review:moderate')
  list(@Query() q: AdminListDto) {
    return this.reviews.adminList({ status: q.status, providerId: q.provider_id, rating: q.rating, cursor: q.cursor, limit: q.limit ?? 25 });
  }

  @Post(':reviewId/hide')
  @HttpCode(200)
  @RequirePlatformPermission('review:moderate')
  async hide(@CurrentActor() actor: Actor, @Param('reviewId', uuid()) reviewId: string, @Body() dto: ReasonDto) {
    return { data: await this.reviews.hide(actor.userId, reviewId, dto.reason) };
  }

  @Post(':reviewId/unhide')
  @HttpCode(200)
  @RequirePlatformPermission('review:moderate')
  async unhide(@CurrentActor() actor: Actor, @Param('reviewId', uuid()) reviewId: string) {
    return { data: await this.reviews.unhide(actor.userId, reviewId) };
  }
}
