import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { Clock, DatabaseService, LOGGER } from '../shared-kernel';

const LOCK_KEY = 727_275; // pg advisory lock: only one worker runs maintenance at a time

/**
 * Housekeeping for the shared `platform` tables. Idempotent and safe to run on every worker; an
 * advisory lock makes concurrent runs skip instead of pile up. (Module-owned cleanup, e.g. expired OTP
 * challenges, belongs to that module and is added with it.)
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<{ skipped: boolean; idempotency: number; rateLimits: number; outbox: number }> {
    const client = await this.database.pool.connect();
    try {
      const locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok as boolean;
      if (!locked) return { skipped: true, idempotency: 0, rateLimits: 0, outbox: 0 };
      try {
        const now = this.clock.now();
        const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
        const idem = await client.query('DELETE FROM platform.idempotency_records WHERE expires_at < $1', [now]);
        const limits = await client.query('DELETE FROM platform.rate_limit_counters WHERE window_start < $1', [day(2)]);
        // Delivered events are kept briefly for debugging; FAILED ones are NEVER auto-deleted (operator decides).
        const outbox = await client.query("DELETE FROM platform.outbox_events WHERE status = 'DONE' AND processed_at < $1", [day(14)]);
        const result = { skipped: false, idempotency: idem.rowCount ?? 0, rateLimits: limits.rowCount ?? 0, outbox: outbox.rowCount ?? 0 };
        this.logger.info(result, 'maintenance completed');
        return result;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}
