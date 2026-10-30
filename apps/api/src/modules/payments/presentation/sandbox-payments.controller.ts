import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { APP_CONFIG, Actor, AppConfig, ConflictError, CurrentActor, NotFoundError } from '../../../shared-kernel';
import { PaymentIntentService } from '../application/payment-intent.service';
import { WebhookService } from '../application/webhook.service';
import { ProviderRejectedError } from '../domain/payment-provider';
import { SandboxPaymentProvider } from '../infrastructure/sandbox.provider';

class SandboxPayDto {
  @IsUUID() intent_id!: string;
  @IsIn(['SUCCESS', 'FAILURE']) outcome!: 'SUCCESS' | 'FAILURE';
  /** false = simulate a callback that never arrives (the server must still settle the payment by asking the provider). */
  @IsOptional() @IsBoolean() deliver_webhook?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount_minor?: number;
}

/**
 * Stands in for "the customer completes checkout at the provider". It exists ONLY while PAYMENT_PROVIDER=sandbox (which
 * configuration refuses in production); otherwise every route here answers 404 as if it were not there.
 */
@ApiTags('payments-sandbox')
@Controller({ path: 'payments/sandbox', version: '1' })
export class SandboxPaymentsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sandbox: SandboxPaymentProvider,
    private readonly intents: PaymentIntentService,
    private readonly webhooks: WebhookService,
  ) {}

  @Post('pay')
  @HttpCode(200)
  async pay(@CurrentActor() actor: Actor, @Body() dto: SandboxPayDto) {
    if (this.config.payments.provider !== 'sandbox' || this.config.isProduction) throw new NotFoundError('Route');

    const intent = await this.intents.get(actor.userId, dto.intent_id); // owner-only
    const orderId = intent.checkout?.['order_id'];
    if (typeof orderId !== 'string') throw new ConflictError('INTENT_NOT_PAYABLE', 'This payment request can no longer be paid');

    let payment;
    try {
      payment = await this.sandbox.simulatePayment({ orderId, outcome: dto.outcome, amountMinor: dto.amount_minor === undefined ? undefined : BigInt(dto.amount_minor) });
    } catch (err) {
      if (err instanceof ProviderRejectedError) throw new ConflictError(err.code, err.message);
      throw err;
    }

    // The provider "calls us back", in-process, exactly as it would over HTTP. A failure here is the provider's problem to
    // retry — it must not undo the payment the customer just made.
    let webhookDelivered = false;
    if (dto.deliver_webhook !== false) {
      const hook = this.sandbox.paymentWebhook(payment);
      try {
        await this.webhooks.receive(this.sandbox.name, hook.rawBody, hook.headers);
        webhookDelivered = true;
      } catch {
        webhookDelivered = false;
      }
    }
    return { data: { payment_id: payment.paymentId, status: payment.status, webhook_delivered: webhookDelivered } };
  }
}
