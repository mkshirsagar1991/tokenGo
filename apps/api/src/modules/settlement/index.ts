// Public API of the settlement module (provider payables, bank accounts, payouts).
export { SettlementModule } from './settlement.module';
export { PayoutService } from './application/payout.service';
export { PayoutProvider } from './domain/payout-provider';
export type { ProviderPayout } from './domain/payout-provider';
// The in-database simulator. Exported for tests; refused in production by configuration.
export { SandboxPayoutProvider } from './infrastructure/sandbox-payout.provider';
