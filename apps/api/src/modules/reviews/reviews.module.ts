import { Injectable, Module } from '@nestjs/common';
import { OutboxConsumer, OutboxEvent, OutboxHandler } from '../../shared-kernel';
import { AuditModule } from '../audit';
import { BookingModule } from '../booking';
import { IdentityAccessModule } from '../identity-access';
import { PlatformModule } from '../platform';
import { ProviderManagementModule } from '../provider-management';
import { ReviewService } from './application/review.service';
import { AdminReviewController, CustomerReviewController, ProviderReviewController, PublicReviewController } from './presentation/reviews.controller';

/** An account was deleted: the words of the person are removed from their reviews (the rating stays a number in the aggregate). */
@Injectable()
@OutboxConsumer({ consumer: 'reviews-user-deleted', events: ['identity.user_deleted'] })
export class ReviewUserDeletedConsumer implements OutboxHandler {
  constructor(private readonly reviews: ReviewService) {}

  async handle(event: OutboxEvent): Promise<void> {
    await this.reviews.eraseCustomerText(String(event.payload['user_id']));
  }
}

@Module({
  imports: [AuditModule, IdentityAccessModule, PlatformModule, BookingModule, ProviderManagementModule],
  controllers: [CustomerReviewController, PublicReviewController, ProviderReviewController, AdminReviewController],
  providers: [ReviewService, ReviewUserDeletedConsumer],
  exports: [ReviewService],
})
export class ReviewsModule {}
