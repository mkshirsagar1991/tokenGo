import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { sql } from 'kysely';
import { APP_CONFIG, AppConfig, Clock, DatabaseService, UnitOfWork } from '../../../shared-kernel';
import { Public } from '../../identity-access';

const STARTED_AT = Date.now();

/**
 * Liveness and readiness for the load balancer and orchestrator (requirements §31). `live` answers as long as the process can
 * serve HTTP and touches nothing else; `ready` also proves the database answers within a short deadline. Neither requires
 * authentication and neither returns anything sensitive.
 */
@ApiTags('ops')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000) };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    let database: 'ok' | 'down' = 'ok';
    let outbox: { pending: number; oldest_pending_seconds: number | null } | null = null;
    try {
      await withDeadline(this.database.pool.query('SELECT 1'), 2_000);
      // Informational: how far behind is the worker? (A large, growing number means the worker is down or stuck.)
      const row = (
        await sql<{ pending: string; oldest: Date | null }>`
          SELECT count(*)::text AS pending, min(available_at) AS oldest
            FROM platform.outbox_events WHERE status = 'PENDING' AND available_at <= ${this.clock.now()}`.execute(this.uow.db<unknown>())
      ).rows[0]!;
      outbox = { pending: Number(row.pending), oldest_pending_seconds: row.oldest ? Math.max(0, Math.round((this.clock.now().getTime() - row.oldest.getTime()) / 1000)) : null };
    } catch {
      database = 'down';
    }
    if (database === 'down') res.status(503);
    return {
      status: database === 'ok' ? 'ok' : 'unavailable',
      checks: { database },
      outbox,
      environment: this.config.env,
      latency_ms: Date.now() - started,
    };
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
