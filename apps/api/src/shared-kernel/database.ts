import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Kysely, PostgresDialect, Transaction } from 'kysely';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from './config';

/** PostgreSQL error codes that are safe to retry a whole transaction on. */
const RETRYABLE_SQLSTATES = new Set(['40001' /* serialization_failure */, '40P01' /* deadlock_detected */]);
const MAX_TX_ATTEMPTS = 3;

/**
 * Owns the connection pool. Modules never construct their own pools. Note: `bigint` columns are
 * returned by `pg` as strings; repositories convert explicitly (`BigInt(row.amount_minor)`) so no
 * float can ever sneak into money handling.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly kysely: Kysely<unknown>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
    this.kysely = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: this.pool }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.kysely.destroy();
  }
}

/**
 * Unit of Work — the single mechanism by which modules share ONE database transaction
 * (docs §D.3: booking + hold must commit atomically). Repositories call `uow.db<T>()` and
 * transparently get the ambient transaction when one is open, otherwise the pooled connection.
 *
 * Isolation is READ COMMITTED with explicit row locks and constraints doing the arbitration
 * (docs §L.1 #5). Deadlocks/serialization failures are retried a bounded number of times, which is
 * only safe because the callback must not perform non-DB side effects (outbox/jobs handle those).
 */
@Injectable()
export class UnitOfWork {
  private readonly als = new AsyncLocalStorage<Transaction<unknown>>();

  constructor(private readonly database: DatabaseService) {}

  /** The ambient transaction if one is open, else the shared Kysely instance. Typed per module. */
  db<T>(): Kysely<T> {
    return (this.als.getStore() ?? this.database.kysely) as unknown as Kysely<T>;
  }

  get inTransaction(): boolean {
    return this.als.getStore() !== undefined;
  }

  async run<R>(work: () => Promise<R>): Promise<R> {
    if (this.als.getStore()) return work(); // join the surrounding transaction; no nested tx/retry

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.database.kysely
          .transaction()
          .setIsolationLevel('read committed')
          .execute((trx) => this.als.run(trx, work));
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (attempt < MAX_TX_ATTEMPTS && code && RETRYABLE_SQLSTATES.has(code)) continue;
        throw err;
      }
    }
  }
}

/** Postgres SQLSTATE helpers used to map constraint violations to domain errors. */
export function pgErrorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

export function pgConstraint(err: unknown): string | undefined {
  return (err as { constraint?: string } | null)?.constraint;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FK_VIOLATION = '23503';
