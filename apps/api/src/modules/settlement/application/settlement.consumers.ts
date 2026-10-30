import { Injectable } from '@nestjs/common';
import { OutboxConsumer, OutboxEvent, OutboxHandler } from '../../../shared-kernel';
import { PayableService } from './payable.service';
import { PayoutAccountService } from './payout-account.service';
import { PayoutService } from './payout.service';

/** The ledger credited a provider's payable (a completed service, a cancellation fee, a no-show fee): record what is now owed. */
@Injectable()
@OutboxConsumer({ consumer: 'settlement-provider-payable', events: ['ledger.provider_payable_credited'] })
export class ProviderPayableConsumer implements OutboxHandler {
  constructor(private readonly payables: PayableService) {}

  async handle(event: OutboxEvent): Promise<void> {
    const p = event.payload;
    await this.payables.record({
      providerId: String(p['provider_id']),
      bookingId: typeof p['booking_id'] === 'string' ? p['booking_id'] : null,
      ledgerTxnId: String(p['txn_id']),
      netMinor: BigInt(Number(p['net_minor'])),
      commissionMinor: BigInt(Number(p['commission_minor'] ?? 0)),
      currency: String(p['currency'] ?? 'INR'),
    });
  }
}

/** A new bank account must be checked before it can ever be paid. */
@Injectable()
@OutboxConsumer({ consumer: 'settlement-bank-verification', events: ['settlement.bank_verification_requested'] })
export class BankVerificationConsumer implements OutboxHandler {
  constructor(private readonly accounts: PayoutAccountService) {}

  async handle(event: OutboxEvent): Promise<void> {
    await this.accounts.verify(String(event.payload['payout_account_id']));
  }
}

/** Sends a reserved payout to the payout provider AFTER the reservation committed. Query-before-create, see PayoutService. */
@Injectable()
@OutboxConsumer({ consumer: 'settlement-payout-submit', events: ['settlement.payout_requested'] })
export class PayoutSubmitConsumer implements OutboxHandler {
  constructor(private readonly payouts: PayoutService) {}

  async handle(event: OutboxEvent): Promise<void> {
    await this.payouts.submit(String(event.payload['payout_id']));
  }
}
