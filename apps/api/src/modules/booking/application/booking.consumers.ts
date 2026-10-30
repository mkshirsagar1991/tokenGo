import { Injectable } from '@nestjs/common';
import { OutboxConsumer, OutboxEvent, OutboxHandler } from '../../../shared-kernel';
import { BookingService } from './booking.service';

/**
 * Time-triggered booking work, delivered by the outbox when the event becomes due — so it runs whether or
 * not any app is open (requirements §17). Both handlers are idempotent and re-check the booking's state
 * under lock; "not due yet" throws so the dispatcher retries with backoff instead of dropping the event.
 */
@Injectable()
@OutboxConsumer({ consumer: 'booking-response-deadline', events: ['booking.response_deadline'] })
export class ResponseDeadlineConsumer implements OutboxHandler {
  constructor(private readonly bookings: BookingService) {}

  async handle(event: OutboxEvent): Promise<void> {
    const outcome = await this.bookings.expireIfDue(String(event.payload['booking_id']));
    if (outcome === 'NOT_DUE') throw new Error('response deadline not reached yet; retrying');
  }
}

@Injectable()
@OutboxConsumer({ consumer: 'booking-settlement-due', events: ['booking.settlement_due'] })
export class SettlementDueConsumer implements OutboxHandler {
  constructor(private readonly bookings: BookingService) {}

  async handle(event: OutboxEvent): Promise<void> {
    const outcome = await this.bookings.settleIfDue(String(event.payload['booking_id']));
    if (outcome === 'NOT_DUE') throw new Error('settlement window not elapsed yet; retrying');
  }
}
