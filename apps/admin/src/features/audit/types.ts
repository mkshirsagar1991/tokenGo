export interface AuditEvent {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

export const AUDIT_FILTER_KEYS = ['actor_id', 'entity_type', 'entity_id', 'action', 'from', 'to'] as const;
