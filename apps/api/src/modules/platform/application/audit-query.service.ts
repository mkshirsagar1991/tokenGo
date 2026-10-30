import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { UnitOfWork } from '../../../shared-kernel';

export interface AuditQuery {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

interface Row {
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  before_data: unknown;
  after_data: unknown;
  metadata: unknown;
}

/** Read side of the append-only audit log. Values were sanitised (credentials/PII redacted) when written. */
@Injectable()
export class AuditQueryService {
  constructor(private readonly uow: UnitOfWork) {}

  async list(q: AuditQuery) {
    const where = [sql`TRUE`];
    if (q.actorId) where.push(sql`actor_id = ${q.actorId}::uuid`);
    if (q.entityType) where.push(sql`entity_type = ${q.entityType}`);
    if (q.entityId) where.push(sql`entity_id = ${q.entityId}`);
    // `action` filters by exact name, or by prefix when it ends with ".*" (e.g. "provider.*").
    if (q.action) where.push(q.action.endsWith('.*') ? sql`action LIKE ${q.action.slice(0, -1).replace(/[\\%_]/g, '\\$&') + '%'}` : sql`action = ${q.action}`);
    if (q.from) where.push(sql`occurred_at >= ${q.from}`);
    if (q.to) where.push(sql`occurred_at < ${q.to}`);
    if (q.cursor) where.push(sql`id < ${q.cursor}::uuid`);
    const rows = (
      await sql<Row>`
        SELECT id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, request_id, before_data, after_data, metadata
          FROM audit.audit_logs
         WHERE ${sql.join(where, sql` AND `)}
         ORDER BY id DESC
         LIMIT ${q.limit + 1}`.execute(this.uow.db<unknown>())
    ).rows;
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((r) => ({
        id: r.id,
        occurred_at: r.occurred_at.toISOString(),
        actor_type: r.actor_type,
        actor_id: r.actor_id,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        request_id: r.request_id,
        before: r.before_data,
        after: r.after_data,
        metadata: r.metadata,
      })),
      meta: { next_cursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null },
    };
  }
}
