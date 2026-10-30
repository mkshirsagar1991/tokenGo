import { Injectable } from '@nestjs/common';
import { OutboxConsumer, OutboxEvent, OutboxHandler } from '../../../shared-kernel';
import { AccountDeletionService } from './account-deletion.service';

/** The grace period of an account deletion has ended: anonymise the account (or postpone it if something still blocks it). */
@Injectable()
@OutboxConsumer({ consumer: 'identity-account-deletion-due', events: ['identity.user_deletion_due'] })
export class AccountDeletionDueConsumer implements OutboxHandler {
  constructor(private readonly deletion: AccountDeletionService) {}

  async handle(event: OutboxEvent): Promise<void> {
    await this.deletion.finalizeIfDue(String(event.payload['user_id']));
  }
}
