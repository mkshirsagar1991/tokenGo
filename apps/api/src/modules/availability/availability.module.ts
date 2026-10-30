import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { CatalogModule } from '../catalog';
import { IdentityAccessModule } from '../identity-access';
import { ProviderManagementModule } from '../provider-management';
import { AvailabilityService } from './application/availability.service';
import { PolicyService } from './application/policy.service';
import { SchedulingService } from './application/scheduling.service';
import { AvailabilityRepository } from './infrastructure/availability.repository';
import { ProviderScheduleController, PublicAvailabilityController } from './presentation/availability.controller';

@Module({
  imports: [AuditModule, IdentityAccessModule, ProviderManagementModule, CatalogModule],
  controllers: [PublicAvailabilityController, ProviderScheduleController],
  providers: [AvailabilityRepository, PolicyService, AvailabilityService, SchedulingService],
  exports: [AvailabilityService, PolicyService],
})
export class AvailabilityModule {}
