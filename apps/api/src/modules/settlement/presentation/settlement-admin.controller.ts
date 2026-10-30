import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBooleanString, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Actor, CurrentActor, RequirePlatformPermission } from '../../../shared-kernel';
import { PayoutAccountService } from '../application/payout-account.service';
import { PayoutReconciliationService } from '../application/payout-reconciliation.service';
import { PayoutService } from '../application/payout.service';
import { SettlementQueryService } from '../application/settlement-query.service';

const uuid = () => new ParseUUIDPipe();
const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

class PageQuery {
  @IsOptional() @num() @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() cursor?: string;
}
class PayoutsQuery extends PageQuery {
  @IsOptional() @IsIn(['RESERVED', 'SUBMITTED', 'PAID', 'FAILED']) status?: 'RESERVED' | 'SUBMITTED' | 'PAID' | 'FAILED';
  @IsOptional() @IsUUID() provider_id?: string;
  @IsOptional() @IsBooleanString() needs_review?: string;
}
class PayablesQuery extends PageQuery {
  @IsOptional() @IsIn(['ACCRUED', 'IN_PAYOUT', 'PAID', 'CLAWED_BACK']) status?: 'ACCRUED' | 'IN_PAYOUT' | 'PAID' | 'CLAWED_BACK';
  @IsOptional() @IsUUID() provider_id?: string;
}
class AccountsQuery extends PageQuery {
  @IsOptional() @IsIn(['PENDING_VERIFICATION', 'VERIFIED', 'VERIFICATION_FAILED', 'REPLACED']) status?: 'PENDING_VERIFICATION' | 'VERIFIED' | 'VERIFICATION_FAILED' | 'REPLACED';
  @IsOptional() @IsUUID() provider_id?: string;
}
class FreezeDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class ReconcileDto {
  @IsISO8601({ strict: true }) from!: string;
  @IsISO8601({ strict: true }) to!: string;
}

/** Finance/support surface for settlement. Every route needs a permission AND (these are privileged roles) an MFA-verified session. */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class SettlementAdminController {
  constructor(
    private readonly payouts: PayoutService,
    private readonly accounts: PayoutAccountService,
    private readonly queries: SettlementQueryService,
    private readonly reconciliation: PayoutReconciliationService,
  ) {}

  // Static paths are declared before `payouts/:id` so they are never mistaken for an id.
  @Get('payouts/integrity')
  @RequirePlatformPermission('payout:read_any')
  async integrity() {
    return { data: await this.queries.integrity() };
  }

  @Get('payouts/holds')
  @RequirePlatformPermission('payout:read_any')
  async holds() {
    return { data: await this.queries.listHolds() };
  }

  /** Runs one payout cycle now (the worker does this on a timer): create due payouts, then re-drive anything stuck. */
  @Post('payouts/run')
  @HttpCode(200)
  @RequirePlatformPermission('payout:operate')
  async run() {
    return { data: await this.payouts.tick() };
  }

  @Post('payouts/reconciliation')
  @RequirePlatformPermission('payout:reconcile')
  async reconcile(@CurrentActor() actor: Actor, @Body() dto: ReconcileDto) {
    return { data: await this.reconciliation.run({ from: new Date(dto.from), to: new Date(dto.to), startedBy: actor.userId }) };
  }

  @Get('payouts/reconciliation/:id')
  @RequirePlatformPermission('payout:read_any')
  async getReconciliation(@Param('id') id: string) {
    return { data: await this.reconciliation.get(id) };
  }

  @Post('payouts/providers/:providerId/freeze')
  @HttpCode(200)
  @RequirePlatformPermission('payout:operate')
  async freeze(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: FreezeDto) {
    await this.payouts.freeze(providerId, dto.reason, actor.userId);
    return { data: { provider_id: providerId, frozen: true } };
  }

  @Post('payouts/providers/:providerId/unfreeze')
  @HttpCode(200)
  @RequirePlatformPermission('payout:operate')
  async unfreeze(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: { provider_id: providerId, was_frozen: await this.payouts.unfreeze(providerId, actor.userId) } };
  }

  @Get('payouts')
  @RequirePlatformPermission('payout:read_any')
  async list(@Query() q: PayoutsQuery) {
    const { data, nextCursor } = await this.queries.listPayouts({ status: q.status, providerId: q.provider_id, needsReview: q.needs_review === 'true', limit: q.limit ?? 30, cursor: q.cursor }, true);
    return { data, meta: { next_cursor: nextCursor } };
  }

  @Get('payouts/:id')
  @RequirePlatformPermission('payout:read_any')
  async get(@Param('id', uuid()) id: string) {
    return { data: await this.queries.payoutDetail(id, undefined, true) };
  }

  /** Re-asks the provider about this payout (and sends it if the provider has never seen it). Safe to repeat. */
  @Post('payouts/:id/refresh')
  @HttpCode(200)
  @RequirePlatformPermission('payout:operate')
  async refresh(@Param('id', uuid()) id: string) {
    return { data: { outcome: await this.payouts.submit(id) } };
  }

  @Get('payables')
  @RequirePlatformPermission('payout:read_any')
  async payables(@Query() q: PayablesQuery) {
    const { data, nextCursor } = await this.queries.listPayables({ status: q.status, providerId: q.provider_id, limit: q.limit ?? 30, cursor: q.cursor });
    return { data, meta: { next_cursor: nextCursor } };
  }

  @Get('payout-accounts')
  @RequirePlatformPermission('payout:read_any')
  async accountsList(@Query() q: AccountsQuery) {
    const { data, nextCursor } = await this.accounts.list({ status: q.status, providerId: q.provider_id, limit: q.limit ?? 30, cursor: q.cursor });
    return { data, meta: { next_cursor: nextCursor } };
  }
}
