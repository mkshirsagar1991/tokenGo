import { Body, Controller, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDefined, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Actor, CurrentActor, RequirePlatformPermission } from '../../identity-access';
import { AuditQueryService } from '../application/audit-query.service';
import { ReportsService } from '../application/reports.service';
import { SettingsService } from '../application/settings.service';

const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

class SettingDto {
  @IsDefined() value!: unknown;
}

class AuditQueryDto {
  @IsOptional() @IsUUID() actor_id?: string;
  @IsOptional() @IsString() @MaxLength(60) entity_type?: string;
  @IsOptional() @IsString() @MaxLength(80) entity_id?: string;
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(100) limit?: number;
}

class RangeDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) to!: string;
  @IsOptional() @IsString() @MaxLength(60) tz?: string;
}

@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class PlatformAdminController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditQueryService,
    private readonly reports: ReportsService,
  ) {}

  // ---- settings -------------------------------------------------------------------------------------------------------
  @Get('settings')
  @RequirePlatformPermission('settings:manage')
  async listSettings() {
    return { data: await this.settings.all() };
  }

  @Put('settings/:key')
  @HttpCode(200)
  @RequirePlatformPermission('settings:manage')
  async setSetting(@CurrentActor() actor: Actor, @Param('key') key: string, @Body() dto: SettingDto) {
    return { data: await this.settings.set(actor.userId, key, dto.value) };
  }

  // ---- audit log ------------------------------------------------------------------------------------------------------
  @Get('audit-logs')
  @RequirePlatformPermission('audit:read')
  list(@Query() q: AuditQueryDto) {
    return this.audit.list({
      actorId: q.actor_id,
      entityType: q.entity_type,
      entityId: q.entity_id,
      action: q.action,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      cursor: q.cursor,
      limit: q.limit ?? 50,
    });
  }

  // ---- reports --------------------------------------------------------------------------------------------------------
  @Get('reports/overview')
  @RequirePlatformPermission('report:read')
  async overview(@Query() q: RangeDto) {
    return { data: await this.reports.overview({ from: q.from, to: q.to, tz: q.tz ?? 'Asia/Kolkata' }) };
  }

  @Get('reports/daily')
  @RequirePlatformPermission('report:read')
  daily(@Query() q: RangeDto) {
    return this.reports.daily({ from: q.from, to: q.to, tz: q.tz ?? 'Asia/Kolkata' });
  }
}
