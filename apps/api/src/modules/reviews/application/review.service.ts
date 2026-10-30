import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock, ConflictError, NotFoundError, OutboxService, UnitOfWork, uuidv7 } from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { BookingSummaryService } from '../../booking';
import { ProviderAccessService } from '../../provider-management';
import { SettingsService } from '../../platform';
import { normalizeText, validateRating, withinReviewWindow } from '../domain/review-rules';

interface Row {
  id: string;
  booking_id: string;
  customer_id: string;
  provider_id: string;
  location_id: string;
  service_name: string;
  rating: number;
  comment: string | null;
  status: 'PUBLISHED' | 'HIDDEN';
  hidden_reason: string | null;
  reply: string | null;
  replied_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = sql`id, booking_id, customer_id, provider_id, location_id, service_name, rating, comment, status, hidden_reason, reply, replied_at, created_at, updated_at`;

/** What anyone may see: no customer identity at all, only what was booked, the rating, the words, and the business's reply. */
const publicView = (r: Row) => ({
  id: r.id,
  service_name: r.service_name,
  rating: r.rating,
  comment: r.comment,
  created_at: r.created_at.toISOString(),
  reply: r.reply ? { text: r.reply, at: r.replied_at!.toISOString() } : null,
});
/** The author sees their own review's state; the business sees status too. */
const ownView = (r: Row) => ({ ...publicView(r), booking_id: r.booking_id, status: r.status, hidden_reason: r.status === 'HIDDEN' ? r.hidden_reason : null, updated_at: r.updated_at.toISOString() });

@Injectable()
export class ReviewService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly bookings: BookingSummaryService,
    private readonly access: ProviderAccessService,
    private readonly settings: SettingsService,
  ) {}

  // ===== customer ====================================================================================================
  async create(customerId: string, bookingId: string, input: { rating: unknown; comment?: unknown }) {
    const rating = validateRating(input.rating);
    const comment = normalizeText(input.comment, 'comment');
    const summary = await this.eligibleBooking(customerId, bookingId);
    const now = this.clock.now();
    const review = await this.uow.run(async () => {
      const db = this.uow.db<unknown>();
      const inserted = (
        await sql<Row>`
          INSERT INTO reviews.reviews (id, booking_id, customer_id, provider_id, location_id, service_name, rating, comment, created_at, updated_at)
          VALUES (${uuidv7()}::uuid, ${bookingId}::uuid, ${customerId}::uuid, ${summary.providerId}::uuid, ${summary.locationId}::uuid, ${summary.serviceName}, ${rating}, ${comment}, ${now}, ${now})
          ON CONFLICT (booking_id) DO NOTHING
          RETURNING ${COLUMNS}`.execute(db)
      ).rows[0];
      if (!inserted) throw new ConflictError('ALREADY_REVIEWED', 'You have already reviewed this booking. You can edit your review.');
      await this.adjust(summary.locationId, 1, rating);
      await this.outbox.publish({ type: 'reviews.review_created', aggregateType: 'review', aggregateId: inserted.id, payload: { review_id: inserted.id, booking_id: bookingId, provider_id: summary.providerId, location_id: summary.locationId, rating } });
      return inserted;
    });
    return ownView(review);
  }

  async update(customerId: string, bookingId: string, input: { rating?: unknown; comment?: unknown }) {
    const summary = await this.eligibleBooking(customerId, bookingId);
    const now = this.clock.now();
    const review = await this.uow.run(async () => {
      const db = this.uow.db<unknown>();
      const current = (await sql<Row>`SELECT ${COLUMNS} FROM reviews.reviews WHERE booking_id = ${bookingId}::uuid FOR UPDATE`.execute(db)).rows[0];
      if (!current) throw new NotFoundError('Review');
      if (current.status === 'HIDDEN') throw new ConflictError('REVIEW_HIDDEN', 'This review was removed by a moderator and cannot be edited');
      const rating = input.rating === undefined ? current.rating : validateRating(input.rating);
      const comment = input.comment === undefined ? current.comment : normalizeText(input.comment, 'comment');
      const updated = (
        await sql<Row>`UPDATE reviews.reviews SET rating = ${rating}, comment = ${comment}, updated_at = ${now} WHERE id = ${current.id}::uuid RETURNING ${COLUMNS}`.execute(db)
      ).rows[0]!;
      if (rating !== current.rating) await this.adjust(summary.locationId, 0, rating - current.rating);
      return updated;
    });
    return ownView(review);
  }

  async getMine(customerId: string, bookingId: string) {
    const row = (await sql<Row>`SELECT ${COLUMNS} FROM reviews.reviews WHERE booking_id = ${bookingId}::uuid AND customer_id = ${customerId}::uuid`.execute(this.uow.db<unknown>())).rows[0];
    return row ? ownView(row) : null;
  }

  // ===== public ======================================================================================================
  async listForLocation(locationId: string, q: { cursor?: string; limit: number }) {
    const db = this.uow.db<unknown>();
    const rows = (
      await sql<Row>`
        SELECT ${COLUMNS} FROM reviews.reviews
         WHERE location_id = ${locationId}::uuid AND status = 'PUBLISHED' AND (${q.cursor ?? null}::uuid IS NULL OR id < ${q.cursor ?? null}::uuid)
         ORDER BY id DESC LIMIT ${q.limit + 1}`.execute(db)
    ).rows;
    const page = rows.slice(0, q.limit);
    const dist = (await sql<{ rating: number; n: string }>`SELECT rating, count(*)::text AS n FROM reviews.reviews WHERE location_id = ${locationId}::uuid AND status = 'PUBLISHED' GROUP BY rating`.execute(db)).rows;
    const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    let count = 0;
    let sum = 0;
    for (const d of dist) {
      distribution[String(d.rating)] = Number(d.n);
      count += Number(d.n);
      sum += d.rating * Number(d.n);
    }
    return {
      data: page.map(publicView),
      meta: { next_cursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null, summary: { average: count === 0 ? null : Math.round((sum / count) * 100) / 100, count, distribution } },
    };
  }

  // ===== the business ================================================================================================
  async listForProvider(userId: string, providerId: string, q: { cursor?: string; limit: number }) {
    await this.access.requireAtAnyScope(userId, 'review:read', providerId);
    const rows = (
      await sql<Row>`
        SELECT ${COLUMNS} FROM reviews.reviews WHERE provider_id = ${providerId}::uuid AND (${q.cursor ?? null}::uuid IS NULL OR id < ${q.cursor ?? null}::uuid)
         ORDER BY id DESC LIMIT ${q.limit + 1}`.execute(this.uow.db<unknown>())
    ).rows;
    const page = rows.slice(0, q.limit);
    return { data: page.map((r) => ({ ...ownView(r), location_id: r.location_id })), meta: { next_cursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null } };
  }

  /** One public reply per review (it can be edited). The reply is shown under the review to everyone. */
  async reply(userId: string, providerId: string, reviewId: string, rawText: unknown) {
    const text = normalizeText(rawText, 'reply');
    if (!text) throw new ConflictError('REPLY_EMPTY', 'A reply cannot be empty');
    const row = await this.uow.run(async () => {
      const db = this.uow.db<unknown>();
      const review = (await sql<Row>`SELECT ${COLUMNS} FROM reviews.reviews WHERE id = ${reviewId}::uuid AND provider_id = ${providerId}::uuid FOR UPDATE`.execute(db)).rows[0];
      if (!review) throw new NotFoundError('Review');
      await this.access.require(userId, 'review:reply', providerId, review.location_id);
      if (review.status === 'HIDDEN') throw new ConflictError('REVIEW_HIDDEN', 'This review was removed by a moderator');
      const now = this.clock.now();
      return (await sql<Row>`UPDATE reviews.reviews SET reply = ${text}, replied_by = ${userId}::uuid, replied_at = ${now}, updated_at = ${now} WHERE id = ${reviewId}::uuid RETURNING ${COLUMNS}`.execute(db)).rows[0]!;
    });
    return { ...ownView(row), location_id: row.location_id };
  }

  // ===== administrators =============================================================================================
  async adminList(q: { status?: string; providerId?: string; rating?: number; cursor?: string; limit: number }) {
    const rows = (
      await sql<Row>`
        SELECT ${COLUMNS} FROM reviews.reviews
         WHERE (${q.status ?? null}::text IS NULL OR status = ${q.status ?? null})
           AND (${q.providerId ?? null}::uuid IS NULL OR provider_id = ${q.providerId ?? null}::uuid)
           AND (${q.rating ?? null}::int IS NULL OR rating = ${q.rating ?? null}::int)
           AND (${q.cursor ?? null}::uuid IS NULL OR id < ${q.cursor ?? null}::uuid)
         ORDER BY id DESC LIMIT ${q.limit + 1}`.execute(this.uow.db<unknown>())
    ).rows;
    const page = rows.slice(0, q.limit);
    return { data: page.map((r) => ({ ...ownView(r), provider_id: r.provider_id, location_id: r.location_id, customer_id: r.customer_id })), meta: { next_cursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null } };
  }

  async hide(actorId: string, reviewId: string, reason: string) {
    return this.moderate(actorId, reviewId, 'HIDDEN', reason);
  }

  async unhide(actorId: string, reviewId: string) {
    return this.moderate(actorId, reviewId, 'PUBLISHED', null);
  }

  private async moderate(actorId: string, reviewId: string, to: 'HIDDEN' | 'PUBLISHED', reason: string | null) {
    const row = await this.uow.run(async () => {
      const db = this.uow.db<unknown>();
      const review = (await sql<Row>`SELECT ${COLUMNS} FROM reviews.reviews WHERE id = ${reviewId}::uuid FOR UPDATE`.execute(db)).rows[0];
      if (!review) throw new NotFoundError('Review');
      if (review.status === to) throw new ConflictError(to === 'HIDDEN' ? 'REVIEW_ALREADY_HIDDEN' : 'REVIEW_NOT_HIDDEN', to === 'HIDDEN' ? 'This review is already hidden' : 'This review is not hidden');
      const now = this.clock.now();
      const updated = (
        await sql<Row>`
          UPDATE reviews.reviews
             SET status = ${to}, hidden_reason = ${reason}, hidden_by = ${to === 'HIDDEN' ? actorId : null}::uuid, hidden_at = ${to === 'HIDDEN' ? now : null}, updated_at = ${now}
           WHERE id = ${reviewId}::uuid RETURNING ${COLUMNS}`.execute(db)
      ).rows[0]!;
      // Hidden reviews do not count towards the public rating; restoring puts them back.
      await this.adjust(review.location_id, to === 'HIDDEN' ? -1 : 1, to === 'HIDDEN' ? -review.rating : review.rating);
      await this.audit.record({ actorType: 'USER', actorId, action: to === 'HIDDEN' ? 'review.hidden' : 'review.restored', entityType: 'review', entityId: reviewId, before: { status: review.status }, after: { status: to }, metadata: { reason, provider_id: review.provider_id } });
      return updated;
    });
    return { ...ownView(row), provider_id: row.provider_id, location_id: row.location_id };
  }

  /** Account deletion: the words of a deleted person are removed; the rating (a number) stays in the aggregate. */
  async eraseCustomerText(customerId: string): Promise<void> {
    await sql`UPDATE reviews.reviews SET comment = NULL WHERE customer_id = ${customerId}::uuid`.execute(this.uow.db<unknown>());
  }

  // ===== internals ===================================================================================================
  private async eligibleBooking(customerId: string, bookingId: string) {
    if (!(await this.settings.get<boolean>('features.reviews_enabled'))) throw new ConflictError('REVIEWS_DISABLED', 'Reviews are switched off at the moment');
    const summary = await this.bookings.get(bookingId);
    // Someone else's booking is indistinguishable from one that does not exist.
    if (!summary || summary.customerId !== customerId) throw new NotFoundError('Booking');
    if (summary.status !== 'CLOSED' || !summary.closedAt) throw new ConflictError('REVIEW_NOT_ALLOWED', 'You can review a booking once the service is completed and confirmed');
    const windowDays = await this.settings.get<number>('reviews.window_days');
    if (!withinReviewWindow(summary.closedAt, this.clock.now(), windowDays)) throw new ConflictError('REVIEW_WINDOW_PASSED', `Reviews can be written within ${windowDays} days of the visit`);
    return summary;
  }

  private async adjust(locationId: string, deltaCount: number, deltaSum: number): Promise<void> {
    const db = this.uow.db<unknown>();
    const now = this.clock.now();
    // UPDATE first: a negative delta must never be offered to an INSERT (its CHECK would fire before the conflict is noticed).
    const updated = await sql`
      UPDATE reviews.location_ratings SET review_count = review_count + ${deltaCount}, rating_sum = rating_sum + ${deltaSum}, updated_at = ${now}
       WHERE location_id = ${locationId}::uuid`.execute(db);
    if (Number(updated.numAffectedRows ?? 0) > 0) return;
    await sql`
      INSERT INTO reviews.location_ratings (location_id, review_count, rating_sum, updated_at) VALUES (${locationId}::uuid, ${deltaCount}, ${deltaSum}, ${now})
      ON CONFLICT (location_id) DO UPDATE SET review_count = reviews.location_ratings.review_count + ${deltaCount}, rating_sum = reviews.location_ratings.rating_sum + ${deltaSum}, updated_at = ${now}`.execute(db);
  }
}
