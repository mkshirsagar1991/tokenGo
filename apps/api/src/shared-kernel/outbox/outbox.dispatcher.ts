import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { Clock } from '../clock';
import { DatabaseService, UnitOfWork } from '../database';
import { LOGGER } from '../tokens';
import { OUTBOX_CONSUMER, OutboxConsumerMeta, matchesEvent } from './outbox.decorators';
import type { OutboxEvent, OutboxHandler } from './outbox.types';

interface Registered {
  meta: OutboxConsumerMeta;
  handler: OutboxHandler;
}

interface EventRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

interface DispatcherDb {
  'platform.outbox_events': {
    id: string;
    aggregate_type: string;
    aggregate_id: string | null;
    event_type: string;
    payload: Record<string, unknown>;
    headers: Record<string, unknown>;
    status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';
    attempts: number;
    available_at: Date;
    locked_until: Date | null;
    processed_at: Date | null;
    last_error: string | null;
    created_at: Date;
  };
  'platform.outbox_deliveries': { event_id: string; consumer: string; delivered_at: Date };
}

export interface DispatcherOptions {
  batchSize: number;
  /** How long a claim is honoured before another worker may take the event over (crash recovery). */
  claimSeconds: number;
  maxAttempts: number;
  baseBackoffSeconds: number;
  maxBackoffSeconds: number;
}

export const DEFAULT_DISPATCHER_OPTIONS: DispatcherOptions = {
  batchSize: 20,
  claimSeconds: 60,
  maxAttempts: 8,
  baseBackoffSeconds: 5,
  maxBackoffSeconds: 900,
};

/**
 * Delivers outbox events to their consumers.
 *
 *  - CLAIM: events are claimed with `FOR UPDATE SKIP LOCKED` and a visibility timeout, so any number of
 *    workers can run and a crashed worker's claim expires on its own.
 *  - EXACTLY-ONCE FOR DB EFFECTS: each (event, consumer) pair runs inside its own transaction together
 *    with its row in `outbox_deliveries`; a retry re-runs only the consumers that have not finished.
 *    Consumers with EXTERNAL side effects (push/SMS) get at-least-once and must dedupe on `event.id`.
 *  - FAILURE: exponential backoff with a cap; after `maxAttempts` the event is parked as FAILED
 *    (dead-letter) for an operator — never silently dropped.
 */
@Injectable()
export class OutboxDispatcher implements OnModuleInit {
  private registered: Registered[] = [];
  options: DispatcherOptions = { ...DEFAULT_DISPATCHER_OPTIONS };

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly uow: UnitOfWork,
    private readonly database: DatabaseService,
    private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.registered = this.discoverConsumers();
    const names = this.registered.map((r) => r.meta.consumer);
    if (new Set(names).size !== names.length) throw new Error(`Duplicate outbox consumer names: ${names.join(', ')}`);
  }

  private discoverConsumers(): Registered[] {
    const found: Registered[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const meta = this.reflector.get<OutboxConsumerMeta | undefined>(OUTBOX_CONSUMER, metatype);
      if (!meta) continue;
      if (typeof (instance as OutboxHandler).handle !== 'function') {
        throw new Error(`Outbox consumer "${meta.consumer}" must implement handle()`);
      }
      found.push({ meta, handler: instance as OutboxHandler });
    }
    return found;
  }

  get consumers(): string[] {
    return this.registered.map((r) => r.meta.consumer);
  }

  /** Claims and processes one batch. Returns what happened (used by the runner and by tests). */
  async processBatch(): Promise<{ claimed: number; done: number; retried: number; failed: number }> {
    const events = await this.claim();
    const result = { claimed: events.length, done: 0, retried: 0, failed: 0 };
    for (const ev of events) {
      const outcome = await this.deliver(ev);
      result[outcome] += 1;
    }
    return result;
  }

  private async claim(): Promise<EventRow[]> {
    const now = this.clock.now();
    const until = new Date(now.getTime() + this.options.claimSeconds * 1000);
    const db = this.database.kysely as unknown as Kysely<DispatcherDb>;
    return db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('platform.outbox_events')
        .select(['id'])
        .where('available_at', '<=', now)
        .where((eb) =>
          eb.or([
            eb('status', '=', 'PENDING'),
            eb.and([eb('status', '=', 'PROCESSING'), eb('locked_until', '<', now)]), // expired claim: take over
          ]),
        )
        .orderBy('available_at')
        .orderBy('id')
        .limit(this.options.batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return [];
      return trx
        .updateTable('platform.outbox_events')
        .set({ status: 'PROCESSING', locked_until: until })
        .where('id', 'in', rows.map((r) => r.id))
        .returning(['id', 'event_type', 'aggregate_type', 'aggregate_id', 'payload', 'headers', 'attempts', 'created_at'])
        .execute();
    });
  }

  private toEvent(row: EventRow): OutboxEvent {
    return {
      id: row.id,
      type: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      headers: row.headers,
      attempts: row.attempts,
      createdAt: row.created_at,
    };
  }

  private async deliver(row: EventRow): Promise<'done' | 'retried' | 'failed'> {
    const event = this.toEvent(row);
    const targets = this.registered.filter((r) => matchesEvent(r.meta.events, event.type));
    try {
      for (const target of targets) {
        await this.uow.run(async () => {
          const db = this.uow.db<DispatcherDb>();
          const inserted = await db
            .insertInto('platform.outbox_deliveries')
            .values({ event_id: event.id, consumer: target.meta.consumer, delivered_at: this.clock.now() })
            .onConflict((oc) => oc.doNothing())
            .executeTakeFirst();
          if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) return; // already delivered earlier
          await target.handler.handle(event); // throws => this txn (incl. the delivery row) rolls back
        });
      }
      await this.uow.run(async () => {
        await this.uow
          .db<DispatcherDb>()
          .updateTable('platform.outbox_events')
          .set({ status: 'DONE', processed_at: this.clock.now(), locked_until: null, last_error: null })
          .where('id', '=', event.id)
          .execute();
      });
      return 'done';
    } catch (err) {
      return this.recordFailure(event, err);
    }
  }

  private async recordFailure(event: OutboxEvent, err: unknown): Promise<'retried' | 'failed'> {
    const attempts = event.attempts + 1;
    const dead = attempts >= this.options.maxAttempts;
    const delay = Math.min(this.options.baseBackoffSeconds * 2 ** (attempts - 1), this.options.maxBackoffSeconds);
    const jitter = 1 + Math.random() * 0.2;
    const availableAt = new Date(this.clock.now().getTime() + delay * jitter * 1000);
    // Error text is logged/stored for operators; keep it bounded and never include the payload.
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);

    await this.uow.run(async () => {
      await this.uow
        .db<DispatcherDb>()
        .updateTable('platform.outbox_events')
        .set({
          status: dead ? 'FAILED' : 'PENDING',
          attempts: sql<number>`attempts + 1`,
          available_at: dead ? undefined : availableAt,
          locked_until: null,
          last_error: message,
        })
        .where('id', '=', event.id)
        .execute();
    });
    this.logger.warn({ event_id: event.id, type: event.type, attempts, dead }, `outbox delivery failed: ${message}`);
    return dead ? 'failed' : 'retried';
  }
}
