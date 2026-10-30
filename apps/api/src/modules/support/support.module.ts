import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { BookingModule } from '../booking';
import { IdentityAccessModule } from '../identity-access';
import { PlatformModule } from '../platform';
import { ProviderManagementModule } from '../provider-management';
import { SupportService } from './application/support.service';
import { AdminSupportController, BookingDisputeController, SupportCaseController } from './presentation/support.controller';

@Module({
  imports: [AuditModule, IdentityAccessModule, PlatformModule, BookingModule, ProviderManagementModule],
  controllers: [BookingDisputeController, SupportCaseController, AdminSupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
