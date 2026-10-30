import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { WorkerModule } from '../src/worker/worker.module';
import { OutboxDispatcher, OutboxService, UnitOfWork, uuidv7 } from '../src/shared-kernel';
import { TestSchema, createTestDatabase } from './support/db';

/**
 * The worker is a separate entry point (`main.worker.ts`) that no HTTP test boots. This suite boots the REAL
 * WorkerModule against a real database, so a wiring mistake (a provider the worker cannot resolve, a consumer that is
 * never registered) fails here instead of at deploy time.
 */
describe('Worker process wiring (integration, real PostgreSQL)', () => {
  let schema: TestSchema;
  let pool: Pool;
  let worker: TestingModule;

  beforeAll(async () => {
    schema = await createTestDatabase();
    pool = new Pool({ connectionString: schema.databaseUrl, max: 2 });
    Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'fatal', SMS_PROVIDER: 'console', DATABASE_URL: schema.databaseUrl });
    worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await worker.init(); // runs onApplicationBootstrap: the outbox loop and the periodic sweepers start
  });

  afterAll(async () => {
    // Each step is guarded so a failed start-up cannot leak the database (this is exactly how the suite first failed).
    try {
      await worker?.close(); // graceful: finishes the batch in flight, stops the timers
    } finally {
      await pool?.end();
      await schema?.drop();
    }
  });

  it('registers the consumers of every module that publishes time-driven or follow-up work', () => {
    expect(worker.get(OutboxDispatcher).consumers).toEqual(
      expect.arrayContaining(['booking-response-deadline', 'booking-settlement-due', 'identity-account-deletion-due', 'notifications-deliver', 'notifications-events', 'notifications-user-deleted', 'payments-intent-check', 'payments-refund-submit', 'reviews-user-deleted', 'settlement-bank-verification', 'settlement-payout-submit', 'settlement-provider-payable']),
    );
  });

  it('actually delivers a payments event end to end through the running loop', async () => {
    const uow = worker.get(UnitOfWork);
    const outbox = worker.get(OutboxService);
    // An intent id nobody owns: the consumer finds nothing to check and the event completes. What matters is that the
    // loop claimed it, routed it to the payments consumer and recorded the delivery.
    const missing = uuidv7();
    await uow.run(async () => {
      await outbox.publish({ type: 'payments.intent_check', aggregateType: 'payment_intent', aggregateId: missing, payload: { intent_id: missing, attempt: 1 } });
    });

    let status = 'PENDING';
    for (let i = 0; i < 40 && status !== 'DONE'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = (await pool.query("SELECT status FROM platform.outbox_events WHERE aggregate_id = $1", [missing])).rows[0].status as string;
    }
    expect(status).toBe('DONE');
    const delivered = await pool.query("SELECT consumer FROM platform.outbox_deliveries d JOIN platform.outbox_events e ON e.id = d.event_id WHERE e.aggregate_id = $1", [missing]);
    expect(delivered.rows.map((r) => r.consumer)).toEqual(['payments-intent-check']);
  }, 20_000);
});
