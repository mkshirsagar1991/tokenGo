// Public API of the reviews module. Discovery reads the rating through the `search.location_listing` view, not through code.
export { ReviewsModule } from './reviews.module';
export { ReviewService } from './application/review.service';
export { normalizeText, validateRating, withinReviewWindow } from './domain/review-rules';
