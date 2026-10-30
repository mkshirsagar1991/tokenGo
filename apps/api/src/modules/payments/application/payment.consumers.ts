import { Injectable } from '@nestjs/common';
import { OutboxConsumer, OutboxEvent, OutboxHandler } from '../../../shared-kernel';
import { PaymentRecoveryService } from './payment-recovery.service';
import { RefundService } from './refund.service';

/**
 * "Did this top-up get paid?" — scheduled when an intent is created and re-scheduled until it settles or expires, so a
 * lost or delayed webhook never strands a customer's money. The event is only delivered once it is due.
 */
@Injectable()
@OutboxConsumer({ consumer: 'payments-intent-check', events: ['payments.intent_check'] })
export class IntentCheckConsumer implements OutboxHandler {
  constructor(private readonly recovery: PaymentRecoveryService) {}

  async handle(event: OutboxEvent): Promise<void> {
    await this.recovery.recoverIntent(String(event.payload['intent_id']), { reschedule: true, attempt: Number(event.payload['attempt'] ?? 1) });
  }
}

/** Sends a requested refund to the provider AFTER the request committed. Idempotent end to end (see RefundService). */
@Injectable()
@OutboxConsumer({ consumer: 'payments-refund-submit', events: ['payments.refund_requested'] })
export class RefundSubmitConsumer implements OutboxHandler {
  constructor(private readonly refunds: RefundService) {}

  async handle(event: OutboxEvent): Promise<void> {
    await this.refunds.submit(String(event.payload['refund_id']));
  }
}
