import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor, CurrentActor, Idempotent, RequirePlatformPermission } from '../../../shared-kernel';
import { PaymentsQueryService } from '../application/payments-query.service';
import { ReconciliationService } from '../application/reconciliation.service';
import { RefundService } from '../application/refund.service';

const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

class CreateRefundDto {
  @IsUUID() payment_transaction_id!: string;
  /** Omit to refund everything still refundable on the payment. */
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount_minor?: number;
  @IsString() @MaxLength(500) reason!: string;
}

class ReconcileDto {
  @IsISO8601({ strict: true }) from!: string;
  @IsISO8601({ strict: true }) to!: string;
}

class PageQuery {
  @IsOptional() @num() @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() cursor?: string;
}

class TransactionsQuery extends PageQuery {
  @IsOptional() @IsIn(['CAPTURED', 'FAILED', 'QUARANTINED']) status?: 'CAPTURED' | 'FAILED' | 'QUARANTINED';
  @IsOptional() @IsUUID() customer_id?: string;
}

class WebhookEventsQuery extends PageQuery {
  @IsOptional() @IsIn(['RECEIVED', 'PROCESSED', 'IGNORED', 'REJECTED', 'FAILED']) status?: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'REJECTED' | 'FAILED';
}

class RefundsQuery extends PageQuery {
  @IsOptional() @IsIn(['PROCESSING', 'SUCCEEDED', 'FAILED']) status?: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  @IsOptional() @IsUUID() payment_transaction_id?: string;
}

/** Finance/support surface. Every route needs a permission AND (these are privileged roles) an MFA-verified session. */
@ApiTags('admin')
@Controller({ path: 'admin/payments', version: '1' })
export class PaymentsAdminController {
  constructor(
    private readonly refunds: RefundService,
    private readonly reconciliation: ReconciliationService,
    private readonly queries: PaymentsQueryService,
  ) {}

  @Get('transactions')
  @RequirePlatformPermission('payments:read')
  async transactions(@Query() q: TransactionsQuery) {
    const { data, nextCursor } = await this.queries.listTransactions({ status: q.status, customerId: q.customer_id, limit: q.limit ?? 30, cursor: q.cursor });
    return { data, meta: { next_cursor: nextCursor } };
  }

  @Get('webhook-events')
  @RequirePlatformPermission('payments:read')
  async webhookEvents(@Query() q: WebhookEventsQuery) {
    const { data, nextCursor } = await this.queries.listWebhookEvents({ status: q.status, limit: q.limit ?? 30, cursor: q.cursor });
    return { data, meta: { next_cursor: nextCursor } };
  }

  /** Refund a captured top-up to the original payment method. `Idempotency-Key` is REQUIRED. */
  @Post('refunds')
  @RequirePlatformPermission('refund:create')
  @Idempotent({ required: true })
  async createRefund(@CurrentActor() actor: Actor, @Body() dto: CreateRefundDto, @Headers('idempotency-key') key: string) {
    return {
      data: await this.refunds.create({ paymentTransactionId: dto.payment_transaction_id, amountMinor: dto.amount_minor, reason: dto.reason, idempotencyKey: key, actorId: actor.userId }),
    };
  }

  @Get('refunds')
  @RequirePlatformPermission('payments:read')
  async listRefunds(@Query() q: RefundsQuery) {
    const { data, nextCursor } = await this.refunds.list({ status: q.status, paymentTransactionId: q.payment_transaction_id, limit: q.limit ?? 30, cursor: q.cursor });
    return { data, meta: { next_cursor: nextCursor } };
  }

  @Get('refunds/:id')
  @RequirePlatformPermission('payments:read')
  async getRefund(@Param('id') id: string) {
    return { data: await this.refunds.get(id) };
  }

  @Post('reconciliation')
  @RequirePlatformPermission('payments:reconcile')
  async reconcile(@CurrentActor() actor: Actor, @Body() dto: ReconcileDto) {
    return { data: await this.reconciliation.run({ from: new Date(dto.from), to: new Date(dto.to), startedBy: actor.userId }) };
  }

  @Get('reconciliation/:id')
  @RequirePlatformPermission('payments:read')
  async getReconciliation(@Param('id') id: string) {
    return { data: await this.reconciliation.get(id) };
  }
}
