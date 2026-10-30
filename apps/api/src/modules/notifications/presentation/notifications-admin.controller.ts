import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { sql } from 'kysely';
import { UnitOfWork } from '../../../shared-kernel';
import { RequirePlatformPermission } from '../../identity-access';

const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

class DeliveriesQueryDto {
  @IsOptional() @IsIn(['PENDING', 'SENT', 'FAILED', 'SKIPPED']) status?: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(100) limit?: number;
}

/** Delivery health for operators: which pushes were sent or failed and why. Never exposes message text, tokens or phone numbers. */
@ApiTags('admin')
@Controller({ path: 'admin/notifications', version: '1' })
export class NotificationsAdminController {
  constructor(private readonly uow: UnitOfWork) {}

  @Get('deliveries')
  @RequirePlatformPermission('notification:read_any')
  async deliveries(@Query() q: DeliveriesQueryDto) {
    const limit = q.limit ?? 50;
    const rows = (
      await sql<{ id: string; notification_id: string; user_id: string; kind: string; category: string; audience: string; status: string; attempts: number; last_error: string | null; created_at: Date; sent_at: Date | null }>`
        SELECT d.id, d.notification_id, n.user_id, n.kind, n.category, n.audience, d.status, d.attempts, d.last_error, d.created_at, d.sent_at
          FROM notification.deliveries d JOIN notification.notifications n ON n.id = d.notification_id
         WHERE (${q.status ?? null}::text IS NULL OR d.status = ${q.status ?? null})
           AND (${q.cursor ?? null}::uuid IS NULL OR d.id < ${q.cursor ?? null}::uuid)
         ORDER BY d.id DESC LIMIT ${limit + 1}`.execute(this.uow.db<unknown>())
    ).rows;
    const page = rows.slice(0, limit);
    const counts = (await sql<{ status: string; n: string }>`SELECT status, count(*)::text AS n FROM notification.deliveries GROUP BY status`.execute(this.uow.db<unknown>())).rows;
    return {
      data: page.map((r) => ({ ...r, created_at: r.created_at.toISOString(), sent_at: r.sent_at ? r.sent_at.toISOString() : null })),
      meta: { next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null, totals: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) },
    };
  }
}
