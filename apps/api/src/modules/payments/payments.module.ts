import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../shared-kernel';
import { AuditModule } from '../audit';
import { IdentityAccessModule } from '../identity-access';
import { WalletLedgerModule } from '../wallet-ledger';
import { PaymentIntentService } from './application/payment-intent.service';
import { IntentCheckConsumer, RefundSubmitConsumer } from './application/payment.consumers';
import { PaymentRecoveryService } from './application/payment-recovery.service';
import { PaymentSettlementService } from './application/payment-settlement.service';
import { PaymentsQueryService } from './application/payments-query.service';
import { ReconciliationService } from './application/reconciliation.service';
import { RefundService } from './application/refund.service';
import { WebhookService } from './application/webhook.service';
import { PaymentProvider } from './domain/payment-provider';
import { DisabledPaymentProvider } from './infrastructure/disabled.provider';
import { RazorpayPaymentProvider } from './infrastructure/razorpay.provider';
import { SandboxPaymentProvider } from './infrastructure/sandbox.provider';
import { PaymentsAdminController } from './presentation/payments-admin.controller';
import { PaymentsController } from './presentation/payments.controller';
import { SandboxPaymentsController } from './presentation/sandbox-payments.controller';
import { WebhookController } from './presentation/webhook.controller';

@Module({
  imports: [AuditModule, IdentityAccessModule, WalletLedgerModule],
  controllers: [PaymentsController, SandboxPaymentsController, WebhookController, PaymentsAdminController],
  providers: [
    SandboxPaymentProvider,
    RazorpayPaymentProvider,
    DisabledPaymentProvider,
    {
      // The ONE place that decides which provider is live. Configuration refuses the sandbox and Razorpay in production,
      // and refuses live Razorpay keys everywhere, so no configuration can reach a provider that moves real money.
      provide: PaymentProvider,
      inject: [APP_CONFIG, SandboxPaymentProvider, RazorpayPaymentProvider, DisabledPaymentProvider],
      useFactory: (config: AppConfig, sandbox: SandboxPaymentProvider, razorpay: RazorpayPaymentProvider, disabled: DisabledPaymentProvider): PaymentProvider => {
        switch (config.payments.provider) {
          case 'sandbox':
            return sandbox;
          case 'razorpay':
            return razorpay;
          default:
            return disabled;
        }
      },
    },
    PaymentSettlementService,
    PaymentIntentService,
    RefundService,
    PaymentRecoveryService,
    WebhookService,
    ReconciliationService,
    PaymentsQueryService,
    IntentCheckConsumer,
    RefundSubmitConsumer,
  ],
  exports: [PaymentRecoveryService],
})
export class PaymentsModule {}
