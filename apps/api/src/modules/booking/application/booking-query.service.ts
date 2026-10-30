import { Injectable } from '@nestjs/common';
import { Clock, NotFoundError } from '../../../shared-kernel';
import { AuthorizationService } from '../../identity-access';
import { ProviderAccessService } from '../../provider-management';
import type { BookingStatus } from '../domain/booking-state';
import { BookingRepository, BookingRow } from '../infrastructure/booking.repository';
import { BookingView, BookingViewBuilder } from './booking-view';

/** Reads, with the same IDOR rule as everything else: you see a booking only if it is yours or you serve it. */
@Injectable()
export class BookingQueryService {
  constructor(
    private readonly repo: BookingRepository,
    private readonly views: BookingViewBuilder,
    private readonly access: ProviderAccessService,
    private readonly authz: AuthorizationService,
    private readonly clock: Clock,
  ) {}

  private async authorizeView(userId: string, b: BookingRow): Promise<void> {
    if (b.customer_id === userId) return;
    if (await this.authz.can(userId, 'appointment:read_any')) return;
    await this.access.require(userId, 'appointment:read', b.provider_id, b.location_id); // 404 outsiders / 403 staff lacking it
  }

  async get(userId: string, bookingId: string): Promise<BookingView> {
    const b = await this.repo.findById(bookingId);
    if (!b) throw new NotFoundError('Booking');
    await this.authorizeView(userId, b).catch((e) => {
      // A customer probing someone else's booking id must not learn that it exists.
      throw e;
    });
    return this.views.build(b);
  }

  async events(userId: string, bookingId: string) {
    const b = await this.repo.findById(bookingId);
    if (!b) throw new NotFoundError('Booking');
    await this.authorizeView(userId, b);
    const rows = await this.repo.listEvents(bookingId);
    return rows.map((e) => ({
      id: e.id,
      type: e.event_type,
      from_status: e.from_status,
      to_status: e.to_status,
      actor_type: e.actor_type,
      reason_code: e.reason_code,
      occurred_at: e.occurred_at.toISOString(),
    }));
  }

  async listMine(userId: string, f: { status?: BookingStatus; cursor?: string; limit: number }) {
    const rows = await this.repo.listForCustomer(userId, { status: f.status, beforeId: f.cursor, limit: f.limit + 1 });
    return this.page(rows, f.limit);
  }

  async listForProvider(userId: string, providerId: string, f: { locationId?: string; status?: BookingStatus; from?: Date; to?: Date; cursor?: string; limit: number }) {
    await this.access.require(userId, 'appointment:read', providerId, f.locationId);
    const rows = await this.repo.listForProvider(providerId, { locationId: f.locationId, status: f.status, from: f.from, to: f.to, beforeId: f.cursor, limit: f.limit + 1 });
    return this.page(rows, f.limit);
  }

  private async page(rows: BookingRow[], limit: number) {
    const page = rows.slice(0, limit);
    return { data: await Promise.all(page.map((b) => this.views.build(b))), meta: { next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null, as_of: this.clock.now().toISOString() } };
  }
}
