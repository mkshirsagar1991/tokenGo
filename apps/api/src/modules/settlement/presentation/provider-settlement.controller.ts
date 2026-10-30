import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor, CurrentActor } from '../../../shared-kernel';
import { PayoutAccountService } from '../application/payout-account.service';
import { SettlementQueryService } from '../application/settlement-query.service';

const uuid = () => new ParseUUIDPipe();
const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

class PayoutAccountDto {
  @IsString() @MaxLength(100) holder_name!: string;
  /** Digits only on the wire; stored encrypted and never returned in full. */
  @IsString() @MaxLength(32) account_number!: string;
  @IsString() @MaxLength(16) ifsc!: string;
}

class PageQuery {
  @IsOptional() @num() @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsUUID() cursor?: string;
}

class PayablesQuery extends PageQuery {
  @IsOptional() @IsIn(['ACCRUED', 'IN_PAYOUT', 'PAID', 'CLAWED_BACK']) status?: 'ACCRUED' | 'IN_PAYOUT' | 'PAID' | 'CLAWED_BACK';
}

/** What a provider sees of its own money: earnings, payables, payouts and the bank account it is paid into. */
@ApiTags('settlement')
@Controller({ path: 'providers/:providerId', version: '1' })
export class ProviderSettlementController {
  constructor(
    private readonly accounts: PayoutAccountService,
    private readonly queries: SettlementQueryService,
  ) {}

  /** Set (or replace) the bank account payouts go to. It must pass a bank check before anything is paid to it. */
  @Put('payout-account')
  @HttpCode(200)
  async setAccount(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: PayoutAccountDto) {
    return { data: await this.accounts.set(actor.userId, providerId, { holderName: dto.holder_name, accountNumber: dto.account_number, ifsc: dto.ifsc }) };
  }

  @Get('payout-account')
  async getAccount(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.accounts.getFor(actor.userId, providerId) };
  }

  @Get('earnings')
  async earnings(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.queries.providerEarnings(actor.userId, providerId) };
  }

  @Get('payables')
  async payables(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Query() q: PayablesQuery) {
    const { data, nextCursor } = await this.queries.providerPayables(actor.userId, providerId, { status: q.status, limit: q.limit ?? 20, cursor: q.cursor });
    return { data, meta: { next_cursor: nextCursor } };
  }

  @Get('payouts')
  async payouts(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Query() q: PageQuery) {
    const { data, nextCursor } = await this.queries.providerPayouts(actor.userId, providerId, { limit: q.limit ?? 20, cursor: q.cursor });
    return { data, meta: { next_cursor: nextCursor } };
  }

  @Get('payouts/:payoutId')
  async payout(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Param('payoutId', uuid()) payoutId: string) {
    return { data: await this.queries.providerPayout(actor.userId, providerId, payoutId) };
  }
}
