import { Injectable } from '@nestjs/common';
import { Clock } from '../clock';
import { UnitOfWork } from '../database';
import { uuidv7 } from '../ids';
import { currentRequestId, requestContext } from '../request-context';
import type { NewOutboxEvent } from './outbox.types';

interface OutboxDb {
  'platform.outbox_events': {
    id: string;
    aggregate_type: string;
    aggregate_id: string | null;
    event_type: string;
    payload: string;
    headers: string;
    available_at: Date;
  };
}

/**
 * Transactional outbox writer. Call it INSIDE the same transaction as the state change it announces:
 * if the transaction rolls back the event never existed; if it commits the event is guaranteed to be
 * delivered (at-least-once) by the worker. Consumers therefore never see phantom events, and a
 * notification outage can never corrupt booking or financial state (requirements §26).
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async publish(event: NewOutboxEvent): Promise<string> {
    const id = uuidv7();
    const ctx = requestContext.getStore();
    await this.uow
      .db<OutboxDb>()
      .insertInto('platform.outbox_events')
      .values({
        id,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId ?? null,
        event_type: event.type,
        payload: JSON.stringify(event.payload ?? {}),
        headers: JSON.stringify({ request_id: currentRequestId() ?? null, actor_id: ctx?.actorId ?? null }),
        // Stamped from the SAME clock the dispatcher compares against (never the DB default), so
        // "is it due yet?" is always evaluated against one time source.
        available_at: event.availableAt ?? this.clock.now(),
      })
      .execute();
    return id;
  }
}
