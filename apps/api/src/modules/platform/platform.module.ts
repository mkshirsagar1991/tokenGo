import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { IdentityAccessModule } from '../identity-access';
import { AuditQueryService } from './application/audit-query.service';
import { ReportsService } from './application/reports.service';
import { SettingsService } from './application/settings.service';
import { AppConfigController } from './presentation/app-config.controller';
import { HealthController } from './presentation/health.controller';
import { PlatformAdminController } from './presentation/platform-admin.controller';

@Module({
  imports: [AuditModule, IdentityAccessModule],
  controllers: [HealthController, AppConfigController, PlatformAdminController],
  providers: [SettingsService, AuditQueryService, ReportsService],
  exports: [SettingsService],
})
export class PlatformModule {}
