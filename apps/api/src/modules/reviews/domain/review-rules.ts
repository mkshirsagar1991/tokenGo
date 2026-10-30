import { ValidationFailedError, normalizeText } from '../../../shared-kernel';

export { normalizeText };

export { MAX_TEXT as MAX_COMMENT } from '../../../shared-kernel';

export function validateRating(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 5) throw new ValidationFailedError('rating must be a whole number from 1 to 5');
  return raw;
}

/** Can a booking that closed at `closedAt` still be reviewed at `now`, given the window in days? */
export function withinReviewWindow(closedAt: Date, now: Date, windowDays: number): boolean {
  return now.getTime() - closedAt.getTime() <= windowDays * 86_400_000;
}
