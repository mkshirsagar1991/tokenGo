import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../shared-kernel';
import { AuditModule } from '../audit';
import { IdentityAccessModule } from '../identity-access';
import { ProviderManagementModule } from '../provider-management';
import { WalletLedgerModule } from '../wallet-ledger';
import { PayableService } from './application/payable.service';
import { PayoutAccountService } from './application/payout-account.service';
import { PayoutReconciliationService } from './application/payout-reconciliation.service';
import { PayoutService } from './application/payout.service';
import { SettlementQueryService } from './application/settlement-query.service';
import { BankVerificationConsumer, PayoutSubmitConsumer, ProviderPayableConsumer } from './application/settlement.consumers';
import { PayoutProvider } from './domain/payout-provider';
import { DisabledPayoutProvider } from './infrastructure/disabled-payout.provider';
import { SandboxPayoutProvider } from './infrastructure/sandbox-payout.provider';
import { ProviderSettlementController } from './presentation/provider-settlement.controller';
import { SettlementAdminController } from './presentation/settlement-admin.controller';

@Module({
  imports: [AuditModule, IdentityAccessModule, ProviderManagementModule, WalletLedgerModule],
  controllers: [ProviderSettlementController, SettlementAdminController],
  providers: [
    SandboxPayoutProvider,
    DisabledPayoutProvider,
    {
      // The ONE place that decides which payout provider is live. Production configuration cannot select the sandbox, and
      // no live payout provider exists, so nothing here can send real money.
      provide: PayoutProvider,
      inject: [APP_CONFIG, SandboxPayoutProvider, DisabledPayoutProvider],
      useFactory: (config: AppConfig, sandbox: SandboxPayoutProvider, disabled: DisabledPayoutProvider): PayoutProvider => (config.payouts.provider === 'sandbox' ? sandbox : disabled),
    },
    PayableService,
    PayoutAccountService,
    PayoutService,
    SettlementQueryService,
    PayoutReconciliationService,
    ProviderPayableConsumer,
    BankVerificationConsumer,
    PayoutSubmitConsumer,
  ],
  exports: [PayoutService],
})
export class SettlementModule {}
