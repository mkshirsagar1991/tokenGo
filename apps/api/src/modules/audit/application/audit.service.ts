import { Injectable } from '@nestjs/common';
import { currentRequestId, UnitOfWork, uuidv7 } from '../../../shared-kernel';

export interface AuditEntry {
  actorType: 'USER' | 'SYSTEM';
  actorId?: string | null;
  action: string; // e.g. "provider.approved"
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

/** Keys that must never be persisted in audit data (requirements §30: no credentials/unnecessary PII). */
const FORBIDDEN_KEYS =
  /(^|[_\-.])(?:password|passwd|otp|pin|secret|authorization|cookie|phone|email|card|cvv|latitude|longitude|lat|lng|lon)($|[_\-.])|token|password|secret|api_?key/i;

export function sanitizeAuditData(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => sanitizeAuditData(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = FORBIDDEN_KEYS.test(k) ? '[REDACTED]' : sanitizeAuditData(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Append-only audit trail. Writes through the ambient Unit-of-Work, so an audit row commits (or rolls
 * back) atomically with the change it describes. The table itself rejects UPDATE/DELETE/TRUNCATE.
 */
@Injectable()
export class AuditService {
  constructor(private readonly uow: UnitOfWork) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.uow
      .db<AuditDb>()
      .insertInto('audit.audit_logs')
      .values({
        id: uuidv7(),
        actor_type: entry.actorType,
        actor_id: entry.actorId ?? null,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        request_id: currentRequestId() ?? null,
        before_data: entry.before ? JSON.stringify(sanitizeAuditData(entry.before)) : null,
        after_data: entry.after ? JSON.stringify(sanitizeAuditData(entry.after)) : null,
        metadata: JSON.stringify(sanitizeAuditData(entry.metadata ?? {})),
      })
      .execute();
  }
}

interface AuditDb {
  'audit.audit_logs': {
    id: string;
    actor_type: 'USER' | 'SYSTEM';
    actor_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    request_id: string | null;
    before_data: string | null;
    after_data: string | null;
    metadata: string;
  };
}
