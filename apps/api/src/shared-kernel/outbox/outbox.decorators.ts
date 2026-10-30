import { SetMetadata } from '@nestjs/common';

export const OUTBOX_CONSUMER = 'tokengo:outbox_consumer';

export interface OutboxConsumerMeta {
  /** Stable, unique name. It is the dedupe key in `platform.outbox_deliveries` — never rename it casually. */
  consumer: string;
  /** Exact event types, or a prefix ending in ".*" (e.g. "provider.*"). */
  events: string[];
}

/** Marks a provider (implementing OutboxHandler) as a consumer of outbox events. */
export const OutboxConsumer = (meta: OutboxConsumerMeta) => SetMetadata(OUTBOX_CONSUMER, meta);

export function matchesEvent(patterns: string[], type: string): boolean {
  return patterns.some((p) => (p.endsWith('.*') ? type.startsWith(p.slice(0, -1)) : p === type));
}
