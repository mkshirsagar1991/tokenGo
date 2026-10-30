import { Injectable } from '@nestjs/common';
import { OutboxConsumer, OutboxEvent, OutboxHandler } from '../../../shared-kernel';
import { BookingSummaryService } from '../../booking';
import { ProviderDirectoryService } from '../../provider-management';
import { BookingFacts, Draft, bookingDrafts, payoutDraft, reviewDraft, supportDrafts, walletDraft } from '../domain/templates';
import { DeliveryService } from './delivery.service';
import { NotificationService } from './notification.service';

const PROBE: BookingFacts = { id: 'probe', reference: '', serviceName: '', localStart: '', locationName: null };

/** Turns business events into notifications. Never throws for an event it has nothing to say about. */
@Injectable()
@OutboxConsumer({
  consumer: 'notifications-events',
  events: [
    'booking.*',
    'ledger.wallet_credited',
    'payments.refund_succeeded',
    'payments.refund_failed',
    'settlement.payout_paid',
    'settlement.payout_failed',
    'settlement.payout_account_verified',
    'settlement.payout_account_verification_failed',
    'reviews.review_created',
    'support.*',
  ],
})
export class NotificationEventConsumer implements OutboxHandler {
  constructor(
    private readonly notifications: NotificationService,
    private readonly bookings: BookingSummaryService,
    private readonly directory: ProviderDirectoryService,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const p = event.payload;
    if (event.type.startsWith('booking.')) return this.forBooking(event);

    if (event.type.startsWith('support.')) return this.forSupport(event);

    const review = reviewDraft(event.type, p);
    if (review) {
      const recipients = await this.directory.notificationRecipients(String(p['provider_id']), String(p['location_id']), null);
      return void (await this.notifications.notify(recipients.map((userId) => ({ userId, draft: review }))));
    }

    const wallet = walletDraft(event.type, p);
    if (wallet) return void (await this.notifications.notify([{ userId: String(p['customer_id']), draft: wallet }]));

    const payout = payoutDraft(event.type, p);
    if (payout) {
      const owners = await this.directory.ownerRecipients(String(p['provider_id']));
      await this.notifications.notify(owners.map((userId) => ({ userId, draft: payout })));
    }
  }

  private async forSupport(event: OutboxEvent): Promise<void> {
    const p = event.payload;
    const drafts = supportDrafts(event.type, p);
    const items: { userId: string; draft: Draft }[] = [];
    if (drafts.customer && typeof p['customer_id'] === 'string') items.push({ userId: p['customer_id'], draft: drafts.customer });
    if (drafts.provider && typeof p['provider_id'] === 'string') {
      for (const userId of await this.directory.ownerRecipients(p['provider_id'])) items.push({ userId, draft: drafts.provider });
    }
    await this.notifications.notify(items);
  }

  private async forBooking(event: OutboxEvent): Promise<void> {
    const probe = bookingDrafts(event.type, event.payload, PROBE);
    if (!probe.customer && !probe.provider) return; // e.g. response_deadline / settlement_due: internal, nobody to tell
    const summary = await this.bookings.get(String(event.payload['booking_id']));
    if (!summary) return;
    // A reminder for something that is no longer going to happen would be worse than none.
    if (event.type === 'booking.reminder_due' && summary.status !== 'CONFIRMED') return;

    const drafts = bookingDrafts(event.type, event.payload, { id: summary.id, reference: summary.reference, serviceName: summary.serviceName, localStart: summary.localStart, locationName: summary.locationName });
    const items: { userId: string; draft: Draft }[] = [];
    if (drafts.customer) items.push({ userId: summary.customerId, draft: drafts.customer });
    if (drafts.provider) {
      const recipients = await this.directory.notificationRecipients(summary.providerId, summary.locationId, summary.resourceId);
      for (const userId of recipients) items.push({ userId, draft: drafts.provider });
    }
    await this.notifications.notify(items);
  }
}

/** Sends the pushes queued for a notification. A thrown error = "try again later" (outbox backoff); settled deliveries are never resent. */
@Injectable()
@OutboxConsumer({ consumer: 'notifications-deliver', events: ['notification.deliver'] })
export class NotificationDeliverConsumer implements OutboxHandler {
  constructor(private readonly delivery: DeliveryService) {}

  async handle(event: OutboxEvent): Promise<void> {
    await this.delivery.deliver(String(event.payload['notification_id']));
  }
}

/** An account was deleted: remove its notifications, devices and preferences. */
@Injectable()
@OutboxConsumer({ consumer: 'notifications-user-deleted', events: ['identity.user_deleted'] })
export class NotificationUserDeletedConsumer implements OutboxHandler {
  constructor(private readonly notifications: NotificationService) {}

  async handle(event: OutboxEvent): Promise<void> {
    await this.notifications.eraseUser(String(event.payload['user_id']));
  }
}
