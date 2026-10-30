import { WalletDeletionGuard } from './application/wallet-deletion.guard';
import { Module } from '@nestjs/common';
import { LedgerIntegrityService } from './application/ledger-integrity.service';
import { LedgerPoster } from './application/ledger-poster';
import { LedgerService } from './application/ledger.service';
import { LedgerAdminController, WalletController } from './presentation/wallet.controller';

@Module({
  controllers: [WalletController, LedgerAdminController],
  providers: [WalletDeletionGuard, LedgerPoster, LedgerService, LedgerIntegrityService],
  exports: [LedgerService, LedgerIntegrityService],
})
export class WalletLedgerModule {}
