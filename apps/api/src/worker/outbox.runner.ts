import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import { PaymentRecoveryService } from '../modules/payments';
import { PayoutService } from '../modules/settlement';
import { LOGGER, OutboxDispatcher } from '../shared-kernel';
import { MaintenanceService } from './maintenance.service';

const POLL_MS = 1_000;
const IDLE_BACKOFF_MS = 1_000;
const MAINTENANCE_EVERY_MS = 10 * 60_000;
/** Safety net for lost payment callbacks / refund submissions; the outbox check chain is the primary mechanism. */
const PAYMENT_SWEEP_EVERY_MS = 2 * 60_000;
/** Creates due payouts and re-drives stuck ones. Safe on several workers at once (row locks + a per-provider advisory lock). */
const PAYOUT_TICK_EVERY_MS = 2 * 60_000;

/** The worker's main loop: drain the outbox, sleep when idle, run housekeeping periodically. */
@Injectable()
export class OutboxRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private paymentTimer?: NodeJS.Timeout;
  private payoutTimer?: NodeJS.Timeout;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly maintenance: MaintenanceService,
    private readonly payments: PaymentRecoveryService,
    private readonly payouts: PayoutService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    this.timer = setInterval(() => void this.maintenance.runOnce().catch((e) => this.logger.error({ err: e }, 'maintenance failed')), MAINTENANCE_EVERY_MS);
    this.paymentTimer = setInterval(() => void this.payments.sweep().catch((e) => this.logger.error({ err: e }, 'payment sweep failed')), PAYMENT_SWEEP_EVERY_MS);
    this.payoutTimer = setInterval(() => void this.payouts.tick().catch((e) => this.logger.error({ err: e }, 'payout tick failed')), PAYOUT_TICK_EVERY_MS);
    this.logger.info({ consumers: this.dispatcher.consumers }, 'worker started');
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const { claimed } = await this.dispatcher.processBatch();
        if (claimed === 0) await sleep(POLL_MS);
      } catch (err) {
        this.logger.error({ err }, 'outbox loop error');
        await sleep(IDLE_BACKOFF_MS * 5);
      }
    }
  }

  /** Graceful shutdown: finish the batch in flight, then stop. */
  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.paymentTimer) clearInterval(this.paymentTimer);
    if (this.payoutTimer) clearInterval(this.payoutTimer);
    await this.loop;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
