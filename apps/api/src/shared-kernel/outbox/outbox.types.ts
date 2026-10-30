/** A domain event as stored in the outbox. Payloads must NOT contain PII or secrets (ids and codes only). */
export interface OutboxEvent {
  id: string;
  type: string; // e.g. "provider.approved"
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

export interface NewOutboxEvent {
  type: string;
  aggregateType: string;
  aggregateId?: string | null;
  payload?: Record<string, unknown>;
  /** Defer delivery (e.g. reminders). Defaults to "now". */
  availableAt?: Date;
}

/** Implemented by consumers (notifications, settlement, search read-model, ...). */
export interface OutboxHandler {
  handle(event: OutboxEvent): Promise<void>;
}
