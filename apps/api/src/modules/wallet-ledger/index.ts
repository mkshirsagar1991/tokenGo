// Public API of wallet-ledger (a LEAF module: it depends on shared-kernel and the identity facade only).
export { WalletLedgerModule } from './wallet-ledger.module';
export { LedgerService, PLATFORM_ACCOUNTS } from './application/ledger.service';
export type { Allocation, HoldView, WalletRef } from './application/ledger.service';
export { LedgerIntegrityService } from './application/ledger-integrity.service';
export { InsufficientFundsError } from './domain/errors';
