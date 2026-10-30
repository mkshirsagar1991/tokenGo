import { BookingDeletionGuard } from './application/booking-deletion.guard';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { AvailabilityModule } from '../availability';
import { CatalogModule } from '../catalog';
import { IdentityAccessModule } from '../identity-access';
import { PlatformModule } from '../platform';
import { ProviderManagementModule } from '../provider-management';
import { WalletLedgerModule } from '../wallet-ledger';
import { BookingSummaryService } from './application/booking-summary.service';
import { BookingQueryService } from './application/booking-query.service';
import { BookingViewBuilder } from './application/booking-view';
import { ResponseDeadlineConsumer, SettlementDueConsumer } from './application/booking.consumers';
import { BookingService } from './application/booking.service';
import { BookingRepository } from './infrastructure/booking.repository';
import { AppointmentController, ProviderAppointmentController } from './presentation/appointment.controller';

@Module({
  imports: [AuditModule, IdentityAccessModule, PlatformModule, ProviderManagementModule, CatalogModule, AvailabilityModule, WalletLedgerModule],
  controllers: [AppointmentController, ProviderAppointmentController],
  providers: [BookingDeletionGuard, BookingSummaryService, BookingRepository, BookingViewBuilder, BookingService, BookingQueryService, ResponseDeadlineConsumer, SettlementDueConsumer],
  exports: [BookingService, BookingSummaryService],
})
export class BookingModule {}
