import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Actor, CurrentActor, Idempotent } from '../../../shared-kernel';
import { PaymentIntentService } from '../application/payment-intent.service';

const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

class CreateIntentDto {
  /** Whole paise. The server bounds it and asks the provider for exactly this amount; it is never trusted as a "paid" figure. */
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount_minor!: number;
}

class ListQuery {
  @IsOptional() @num() @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsUUID() cursor?: string;
}

@ApiTags('payments')
@Controller({ path: 'payments/intents', version: '1' })
export class PaymentsController {
  constructor(private readonly intents: PaymentIntentService) {}

  /**
   * Start adding money to the wallet. Returns what the app needs to open the provider's checkout. Nothing is credited
   * here: the wallet is credited only when the provider confirms the payment to the server.
   * `Idempotency-Key` is REQUIRED so a retried request cannot create a second payment.
   */
  @Post()
  @Idempotent({ required: true })
  async create(@CurrentActor() actor: Actor, @Body() dto: CreateIntentDto, @Headers('idempotency-key') key: string) {
    return { data: await this.intents.create(actor.userId, { amountMinor: dto.amount_minor, idempotencyKey: key }) };
  }

  @Get()
  async mine(@CurrentActor() actor: Actor, @Query() q: ListQuery) {
    const { data, nextCursor } = await this.intents.list(actor.userId, { limit: q.limit ?? 20, cursor: q.cursor });
    return { data, meta: { next_cursor: nextCursor } };
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.intents.get(actor.userId, id) };
  }

  /**
   * Call after returning from checkout. The server asks the PROVIDER what happened — the app's claim of success is
   * never used — and returns the intent as the books now stand. Safe to call repeatedly.
   */
  @Post(':id/verify')
  @HttpCode(200)
  async verify(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.intents.verify(actor.userId, id) };
  }
}
