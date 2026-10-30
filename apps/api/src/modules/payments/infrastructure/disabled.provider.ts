import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared-kernel';
import { PaymentProvider, ProviderOrder, ProviderPayment, ProviderRefund, WebhookEnvelope } from '../domain/payment-provider';

/**
 * The only configuration allowed in production today: no live payment provider is approved (docs §K.4), so
 * every payment operation is refused with a clear, stable error instead of silently doing something else.
 */
@Injectable()
export class DisabledPaymentProvider extends PaymentProvider {
  readonly name = 'disabled';

  private refuse(): never {
    throw new DomainError('PAYMENTS_DISABLED', 'Adding money is not available right now', 503);
  }

  createOrder(): Promise<ProviderOrder> {
    return this.refuse();
  }
  checkoutPayload(): Record<string, unknown> {
    return this.refuse();
  }
  fetchPayment(): Promise<ProviderPayment | null> {
    return this.refuse();
  }
  listOrderPayments(): Promise<ProviderPayment[]> {
    return this.refuse();
  }
  listPayments(): Promise<ProviderPayment[]> {
    return this.refuse();
  }
  createRefund(): Promise<ProviderRefund> {
    return this.refuse();
  }
  fetchRefund(): Promise<ProviderRefund | null> {
    return this.refuse();
  }
  verifyWebhook(): WebhookEnvelope {
    return this.refuse();
  }
}
