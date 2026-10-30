import { Module } from '@nestjs/common';
import { SharedKernelModule } from './shared-kernel';
import { AuditModule } from './modules/audit';
import { AvailabilityModule } from './modules/availability';
import { BookingModule } from './modules/booking';
import { CatalogModule } from './modules/catalog';
import { GeoSearchModule } from './modules/geo-search';
import { IdentityAccessModule } from './modules/identity-access';
import { PaymentsModule } from './modules/payments';
import { SettlementModule } from './modules/settlement';
import { NotificationsModule } from './modules/notifications';
import { PlatformModule } from './modules/platform';
import { ProviderManagementModule } from './modules/provider-management';
import { ReviewsModule } from './modules/reviews';
import { SupportModule } from './modules/support';
import { WalletLedgerModule } from './modules/wallet-ledger';

@Module({
  imports: [SharedKernelModule, AuditModule, IdentityAccessModule, ProviderManagementModule, CatalogModule, AvailabilityModule, GeoSearchModule, WalletLedgerModule, BookingModule, PaymentsModule, SettlementModule, PlatformModule, NotificationsModule, ReviewsModule, SupportModule],
})
export class AppModule {}
