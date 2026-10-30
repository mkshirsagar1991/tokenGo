import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
import { Actor, CurrentActor, RequirePlatformPermission } from '../../../shared-kernel';
import { PricingAdminService } from '../application/pricing-admin.service';

class CommissionRuleDto {
  @IsIn(['PLATFORM', 'CATEGORY', 'SERVICE_TYPE', 'PROVIDER', 'PROVIDER_SERVICE']) scope_type!: 'PLATFORM' | 'CATEGORY' | 'SERVICE_TYPE' | 'PROVIDER' | 'PROVIDER_SERVICE';
  @IsOptional() @IsUUID() scope_id?: string;
  @IsIn(['PERCENT', 'FIXED']) kind!: 'PERCENT' | 'FIXED';
  /** 1000 = 10.00 % */
  @IsOptional() @IsInt() @Min(0) @Max(10000) percent_bps?: number;
  @IsOptional() @IsInt() @Min(0) fixed_minor?: number;
  @IsOptional() @IsISO8601({ strict: true }) effective_from?: string;
}

class TierDto {
  @IsInt() @Min(0) @Max(24 * 365) min_hours_before!: number;
  @IsInt() @Min(0) @Max(10000) refund_bps!: number;
}

class CancellationPolicyDto {
  @IsString() @Length(1, 100) name!: string;
  @IsIn(['PLATFORM', 'CATEGORY', 'PROVIDER']) scope_type!: 'PLATFORM' | 'CATEGORY' | 'PROVIDER';
  @IsOptional() @IsUUID() scope_id?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => TierDto) tiers!: TierDto[];
  @IsOptional() @IsInt() @Min(0) @Max(10000) no_show_refund_bps?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) provider_cancel_refund_bps?: number;
  @IsOptional() @IsISO8601({ strict: true }) effective_from?: string;
}

@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class PricingAdminController {
  constructor(private readonly pricing: PricingAdminService) {}

  @Get('commission-rules')
  @RequirePlatformPermission('pricing:read')
  async listCommission() {
    return { data: await this.pricing.listCommissionRules() };
  }

  /** Creates the NEXT VERSION of the rule for that scope (the current one is closed, never edited). */
  @Post('commission-rules')
  @RequirePlatformPermission('pricing:manage')
  async createCommission(@CurrentActor() actor: Actor, @Body() dto: CommissionRuleDto) {
    return {
      data: await this.pricing.createCommissionRule(actor.userId, {
        scopeType: dto.scope_type,
        scopeId: dto.scope_id,
        kind: dto.kind,
        percentBps: dto.percent_bps,
        fixedMinor: dto.fixed_minor,
        effectiveFrom: dto.effective_from,
      }),
    };
  }

  @Get('cancellation-policies')
  @RequirePlatformPermission('pricing:read')
  async listCancellation() {
    return { data: await this.pricing.listCancellationPolicies() };
  }

  @Post('cancellation-policies')
  @RequirePlatformPermission('pricing:manage')
  async createCancellation(@CurrentActor() actor: Actor, @Body() dto: CancellationPolicyDto) {
    return {
      data: await this.pricing.createCancellationPolicy(actor.userId, {
        name: dto.name,
        scopeType: dto.scope_type,
        scopeId: dto.scope_id,
        tiers: dto.tiers.map((t) => ({ minHoursBefore: t.min_hours_before, refundBps: t.refund_bps })),
        noShowRefundBps: dto.no_show_refund_bps,
        providerCancelRefundBps: dto.provider_cancel_refund_bps,
        effectiveFrom: dto.effective_from,
      }),
    };
  }
}
