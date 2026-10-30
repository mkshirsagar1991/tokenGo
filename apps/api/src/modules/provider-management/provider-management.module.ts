import { ProviderDeletionGuard } from './application/provider-deletion.guard';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { IdentityAccessModule } from '../identity-access';
import { PlatformModule } from '../platform';
import { DocumentService } from './application/document.service';
import { LocationService } from './application/location.service';
import { ProviderAccessService } from './application/provider-access.service';
import { ProviderDirectoryService } from './application/provider-directory.service';
import { ProviderService } from './application/provider.service';
import { StaffService } from './application/staff.service';
import { ProviderRepository } from './infrastructure/provider.repository';
import { AdminDocumentController, ProviderDocumentController } from './presentation/document.controller';
import { AdminProviderController, ProviderController, StaffInvitationController } from './presentation/provider.controller';

@Module({
  imports: [AuditModule, IdentityAccessModule, PlatformModule],
  controllers: [ProviderController, StaffInvitationController, AdminProviderController, ProviderDocumentController, AdminDocumentController],
  providers: [DocumentService, ProviderDeletionGuard, ProviderRepository, ProviderAccessService, ProviderDirectoryService, ProviderService, LocationService, StaffService],
  exports: [ProviderAccessService, ProviderDirectoryService],
})
export class ProviderManagementModule {}
