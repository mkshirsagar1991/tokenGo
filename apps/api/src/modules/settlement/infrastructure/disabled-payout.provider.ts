import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared-kernel';
import { BankVerification, PayoutProvider, ProviderPayout } from '../domain/payout-provider';

/**
 * The only configuration allowed in production today: no live payout provider is approved (docs §K.4). Payables still accrue —
 * that is bookkeeping — but no bank account is verified and no payout is ever sent.
 */
@Injectable()
export class DisabledPayoutProvider extends PayoutProvider {
  readonly name = 'disabled';

  private refuse(): never {
    throw new DomainError('PAYOUTS_DISABLED', 'Payouts are not available right now', 503);
  }

  verifyBankAccount(): Promise<BankVerification> {
    return this.refuse();
  }
  createPayout(): Promise<ProviderPayout> {
    return this.refuse();
  }
  fetchPayoutByReference(): Promise<ProviderPayout | null> {
    return this.refuse();
  }
  listPayouts(): Promise<ProviderPayout[]> {
    return this.refuse();
  }
}
