import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { IdentityAccessModule } from '../identity-access';
import { ProviderManagementModule } from '../provider-management';
import { CatalogReadService } from './application/catalog-read.service';
import { CategoryService } from './application/category.service';
import { PolicyResolverService } from './application/policy-resolver.service';
import { PricingAdminService } from './application/pricing-admin.service';
import { ProviderCatalogService } from './application/provider-catalog.service';
import { StaffSkillsService } from './application/staff-skills.service';
import { CatalogRepository } from './infrastructure/catalog.repository';
import {
  AdminCatalogController,
  AdminServiceTypeController,
  ProviderServicesController,
  PublicCatalogController,
  StaffSkillsController,
} from './presentation/catalog.controller';
import { PricingAdminController } from './presentation/pricing.controller';

@Module({
  imports: [AuditModule, IdentityAccessModule, ProviderManagementModule],
  controllers: [PublicCatalogController, AdminCatalogController, AdminServiceTypeController, ProviderServicesController, StaffSkillsController, PricingAdminController],
  providers: [CatalogRepository, CategoryService, ProviderCatalogService, StaffSkillsService, CatalogReadService, PolicyResolverService, PricingAdminService],
  exports: [CatalogReadService, PolicyResolverService],
})
export class CatalogModule {}
