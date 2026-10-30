import { Injectable } from '@nestjs/common';
import {
  Clock,
  DatabaseService,
  LOGGER,
  OutboxConsumer,
  OutboxDispatcher,
  OutboxEvent,
  OutboxHandler,
  OutboxService,
  UnitOfWork,
} from '../src/shared-kernel';
import { MaintenanceService } from '../src/worker/maintenance.service';
import { TestApp, bootTestApp } from './support/app';

/** Records every delivery; `failTimes` makes it throw that many times first. */
@Injectable()
@OutboxConsumer({ consumer: 'test-recorder', events: ['provider.*'] })
class RecorderConsumer implements OutboxHandler {
  readonly seen: OutboxEvent[] = [];
  failTimes = 0;
  alwaysFail = false;
  async handle(event: OutboxEvent): Promise<void> {
    if (this.alwaysFail || this.failTimes > 0) {
      this.failTimes = Math.max(0, this.failTimes - 1);
      throw new Error('simulated downstream outage');
    }
    this.seen.push(event);
  }
}

@Injectable()
@OutboxConsumer({ consumer: 'test-second', events: ['provider.registered', 'test.ping'] })
class SecondConsumer implements OutboxHandler {
  readonly seen: OutboxEvent[] = [];
  async handle(event: OutboxEvent): Promise<void> {
    this.seen.push(event);
  }
}

describe('Outbox & idempotency (integration, real PostgreSQL)', () => {
  let t: TestApp;
  let recorder: RecorderConsumer;
  let second: SecondConsumer;
  let dispatcher: OutboxDispatcher;
  let outbox: OutboxService;
  let uow: UnitOfWork;
  let alice: { userId: string; accessToken: string };
  let bob: { userId: string; accessToken: string };

  const bearer = (u: { accessToken: string }) => ({ Authorization: `Bearer ${u.accessToken}` });
  const count = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows[0].n as number;

  beforeAll(async () => {
    t = await bootTestApp({}, { providers: [RecorderConsumer, SecondConsumer] });
    recorder = t.app.get(RecorderConsumer);
    second = t.app.get(SecondConsumer);
    dispatcher = t.app.get(OutboxDispatcher);
    outbox = t.app.get(OutboxService);
    uow = t.app.get(UnitOfWork);
    alice = await t.login('9300000001');
    bob = await t.login('9300000002');
  });
  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    recorder.seen.length = 0;
    second.seen.length = 0;
    recorder.failTimes = 0;
    recorder.alwaysFail = false;
    dispatcher.options = { batchSize: 20, claimSeconds: 60, maxAttempts: 8, baseBackoffSeconds: 5, maxBackoffSeconds: 900 };
    await t.pool.query("DELETE FROM platform.outbox_events"); // isolate each test's events
  });

  // =====================================================================================================
  describe('transactional outbox', () => {
    it('discovers the consumers declared with @OutboxConsumer', () => {
      // the two test consumers declared in this file, plus the application's real booking, identity, notifications, payments and settlement consumers
      expect(dispatcher.consumers.sort()).toEqual(['booking-response-deadline', 'booking-settlement-due', 'identity-account-deletion-due', 'notifications-deliver', 'notifications-events', 'notifications-user-deleted', 'payments-intent-check', 'payments-refund-submit', 'reviews-user-deleted', 'settlement-bank-verification', 'settlement-payout-submit', 'settlement-provider-payable', 'test-recorder', 'test-second']);
    });

    it('an event published in a rolled-back transaction never exists; a committed one does', async () => {
      await expect(
        uow.run(async () => {
          await outbox.publish({ type: 'test.ping', aggregateType: 'test', payload: { n: 1 } });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await count('SELECT count(*)::int AS n FROM platform.outbox_events')).toBe(0);

      await uow.run(() => outbox.publish({ type: 'test.ping', aggregateType: 'test', payload: { n: 2 } }).then(() => undefined));
      expect(await count("SELECT count(*)::int AS n FROM platform.outbox_events WHERE status = 'PENDING'")).toBe(1);
    });

    it('a real business action (provider registration) emits its event atomically, with no PII in the payload', async () => {
      const res = await t.http.post('/api/v1/providers').set(bearer(alice)).send({ display_name: 'Outbox Salon' }).expect(201);
      const row = (await t.pool.query("SELECT payload, headers FROM platform.outbox_events WHERE event_type = 'provider.registered'")).rows[0];
      expect(row.payload).toEqual({ provider_id: res.body.data.id, owner_user_id: alice.userId });
      expect(JSON.stringify(row.payload)).not.toContain('Outbox Salon');
      expect(row.headers.request_id).toEqual(expect.any(String));
      expect(row.headers.actor_id).toBe(alice.userId);
    });

    it('delivers to each matching consumer exactly once and marks the event DONE', async () => {
      await t.http.post('/api/v1/providers').set(bearer(alice)).send({ display_name: 'Deliver Salon' }).expect(201);
      const r = await dispatcher.processBatch();
      expect(r).toMatchObject({ claimed: 1, done: 1, retried: 0, failed: 0 });
      expect(recorder.seen).toHaveLength(1);
      expect(second.seen).toHaveLength(1);
      expect(recorder.seen[0]).toMatchObject({ type: 'provider.registered', aggregateType: 'provider' });
      expect((await dispatcher.processBatch()).claimed).toBe(0); // nothing left
      expect(await count("SELECT count(*)::int AS n FROM platform.outbox_deliveries")).toBe(2);
    });

    it('routes by event type: a wildcard consumer sees lifecycle events a specific one does not', async () => {
      await outbox.publish({ type: 'provider.approve', aggregateType: 'provider' });
      await dispatcher.processBatch();
      expect(recorder.seen.map((e) => e.type)).toEqual(['provider.approve']);
      expect(second.seen).toHaveLength(0);
    });

    it('an event nobody consumes is completed rather than stuck', async () => {
      await outbox.publish({ type: 'unrelated.thing', aggregateType: 'x' });
      expect(await dispatcher.processBatch()).toMatchObject({ claimed: 1, done: 1 });
    });

    it('retries a failing consumer with exponential backoff and re-runs ONLY the consumer that failed', async () => {
      recorder.failTimes = 2;
      await outbox.publish({ type: 'provider.registered', aggregateType: 'provider', aggregateId: null });

      expect(await dispatcher.processBatch()).toMatchObject({ claimed: 1, retried: 1, done: 0 });
      let ev = (await t.pool.query('SELECT status, attempts, last_error, available_at FROM platform.outbox_events')).rows[0];
      expect(ev).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'simulated downstream outage' });
      expect(ev.available_at.getTime()).toBeGreaterThan(t.clock.now().getTime()); // backed off into the future

      expect((await dispatcher.processBatch()).claimed).toBe(0); // not due yet
      t.clock.advanceSeconds(6);
      expect(await dispatcher.processBatch()).toMatchObject({ claimed: 1, retried: 1 }); // 2nd failure
      ev = (await t.pool.query('SELECT attempts, available_at FROM platform.outbox_events')).rows[0];
      expect(ev.attempts).toBe(2);
      expect(ev.available_at.getTime() - t.clock.now().getTime()).toBeGreaterThan(8_000); // ~10 s: doubled

      t.clock.advanceSeconds(13);
      expect(await dispatcher.processBatch()).toMatchObject({ claimed: 1, done: 1 }); // 3rd attempt succeeds
      expect(recorder.seen).toHaveLength(1);
      // 'test-second' succeeded on the FIRST pass and must not have been invoked again
      expect(second.seen).toHaveLength(1);
    });

    it('parks an event as FAILED (dead letter) after max attempts and never deletes it', async () => {
      dispatcher.options.maxAttempts = 3;
      recorder.alwaysFail = true;
      await outbox.publish({ type: 'provider.registered', aggregateType: 'provider' });
      for (let i = 0; i < 3; i++) {
        await dispatcher.processBatch();
        t.clock.advanceSeconds(1000);
      }
      const ev = (await t.pool.query('SELECT status, attempts, last_error FROM platform.outbox_events')).rows[0];
      expect(ev).toMatchObject({ status: 'FAILED', attempts: 3 });
      expect((await dispatcher.processBatch()).claimed).toBe(0); // dead letters are not retried automatically

      const maintenance = new MaintenanceService(t.app.get(DatabaseService), t.app.get(Clock), t.app.get(LOGGER));
      t.clock.advanceSeconds(40 * 86_400);
      await maintenance.runOnce();
      expect(await count("SELECT count(*)::int AS n FROM platform.outbox_events WHERE status = 'FAILED'")).toBe(1);
    });

    it('is safe with several dispatchers running at once (SKIP LOCKED): every event handled exactly once', async () => {
      dispatcher.options.batchSize = 7;
      for (let i = 0; i < 40; i++) await outbox.publish({ type: 'provider.approve', aggregateType: 'provider', payload: { i } });

      let guard = 0;
      while ((await count("SELECT count(*)::int AS n FROM platform.outbox_events WHERE status <> 'DONE'")) > 0 && guard++ < 20) {
        await Promise.all([dispatcher.processBatch(), dispatcher.processBatch(), dispatcher.processBatch(), dispatcher.processBatch()]);
      }
      expect(recorder.seen).toHaveLength(40);
      expect(new Set(recorder.seen.map((e) => e.id)).size).toBe(40);
    });

    it('recovers events claimed by a crashed worker once the claim expires — and not before', async () => {
      await outbox.publish({ type: 'provider.approve', aggregateType: 'provider' });
      const future = new Date(t.clock.now().getTime() + 60_000);
      await t.pool.query("UPDATE platform.outbox_events SET status = 'PROCESSING', locked_until = $1", [future]);
      expect((await dispatcher.processBatch()).claimed).toBe(0); // still claimed by the "live" worker
      t.clock.advanceSeconds(61);
      expect(await dispatcher.processBatch()).toMatchObject({ claimed: 1, done: 1 });
      expect(recorder.seen).toHaveLength(1);
    });

    it('re-queuing an already-delivered event does not re-run consumers (delivery ledger)', async () => {
      await outbox.publish({ type: 'provider.approve', aggregateType: 'provider' });
      await dispatcher.processBatch();
      expect(recorder.seen).toHaveLength(1);
      await t.pool.query("UPDATE platform.outbox_events SET status = 'PENDING', processed_at = NULL");
      expect(await dispatcher.processBatch()).toMatchObject({ claimed: 1, done: 1 });
      expect(recorder.seen).toHaveLength(1); // not delivered a second time
    });
  });

  // =====================================================================================================
  describe('idempotent commands', () => {
    // The outbox tests above move the fake clock far forward; sign in again so tokens are valid "now".
    beforeEach(async () => {
      alice = await t.login('9300000001');
      bob = await t.login('9300000002');
    });

    const register =(user: { accessToken: string }, key: string | undefined, name = 'Idem Salon') => {
      const req = t.http.post('/api/v1/providers').set(bearer(user));
      if (key) req.set('Idempotency-Key', key);
      return req.send({ display_name: name });
    };
    const providers = (ownerId: string) => count('SELECT count(*)::int AS n FROM provider.providers WHERE owner_user_id = $1', [ownerId]);

    it('replays the original response for a retried request and performs no second effect', async () => {
      const first = await register(alice, 'key-replay-0001').expect(201);
      const again = await register(alice, 'key-replay-0001').expect(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(again.body).toEqual(first.body);
      expect(await count("SELECT count(*)::int AS n FROM provider.providers WHERE display_name = 'Idem Salon' AND owner_user_id = $1", [alice.userId])).toBe(1);
      // the side effects (role grant, audit row, outbox event) also happened exactly once
      expect(await count("SELECT count(*)::int AS n FROM platform.outbox_events WHERE aggregate_id = $1", [first.body.data.id])).toBe(1);
      expect(await count("SELECT count(*)::int AS n FROM audit.audit_logs WHERE entity_id = $1 AND action = 'provider.registered'", [first.body.data.id])).toBe(1);
    });

    it('rejects the same key with a different payload and executes nothing', async () => {
      await register(bob, 'key-mismatch-01', 'Bob One').expect(201);
      const before = await providers(bob.userId);
      const res = await register(bob, 'key-mismatch-01', 'Bob Two').expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await providers(bob.userId)).toBe(before);
    });

    it('scopes keys per user and per route', async () => {
      const a = await register(alice, 'shared-key-0001', 'Scoped A').expect(201);
      const b = await register(bob, 'shared-key-0001', 'Scoped A').expect(201);
      expect(a.body.data.id).not.toBe(b.body.data.id); // another user's identical key is independent
      const loc = {
        name: 'L', address_line1: 'x', city: 'Pune', state: 'MH', postal_code: '411001', latitude: 18.5, longitude: 73.8,
      };
      const l = await t.http.post(`/api/v1/providers/${a.body.data.id}/locations`).set(bearer(alice)).set('Idempotency-Key', 'shared-key-0001').send(loc).expect(201);
      expect(l.headers['idempotent-replayed']).toBeUndefined(); // same key, different route => fresh
    });

    it('collapses a burst of identical concurrent requests into a single execution', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => register(bob, 'key-concurrent-1', 'Burst Salon')));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(await count("SELECT count(*)::int AS n FROM provider.providers WHERE display_name = 'Burst Salon'")).toBe(1);
      expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(5);
    });

    it('does not poison a key when the first attempt FAILS: the corrected retry succeeds', async () => {
      const p = (await register(alice, undefined, 'Fix Me Salon').expect(201)).body.data.id;
      const bad = { name: 'L', address_line1: 'x', city: 'Pune', state: 'MH', postal_code: '411001', latitude: 91, longitude: 73.8 };
      const loc = (body: object) => t.http.post(`/api/v1/providers/${p}/locations`).set(bearer(alice)).set('Idempotency-Key', 'key-after-fail-1').send(body);
      await loc(bad).expect(422);
      expect(await count("SELECT count(*)::int AS n FROM platform.idempotency_records WHERE idempotency_key = 'key-after-fail-1'")).toBe(0);
      await loc({ ...bad, latitude: 18.5 }).expect(201);
    });

    it('validates the key format', async () => {
      const res = await register(alice, 'short').expect(422);
      expect(res.body.errors.fields['idempotency-key']).toBeDefined();
    });

    it('housekeeping deletes expired records but keeps live ones', async () => {
      await register(alice, 'key-expire-0001', 'Expire Salon').expect(201);
      const mine = () => count("SELECT count(*)::int AS n FROM platform.idempotency_records WHERE idempotency_key = 'key-expire-0001'");
      const maintenance = new MaintenanceService(t.app.get(DatabaseService), t.app.get(Clock), t.app.get(LOGGER));
      await maintenance.runOnce();
      expect(await mine()).toBe(1); // still within its 48 h lifetime => kept
      t.clock.advanceSeconds(47 * 3600);
      await maintenance.runOnce();
      expect(await mine()).toBe(1);
      t.clock.advanceSeconds(2 * 3600); // now > 48 h old
      expect((await maintenance.runOnce()).idempotency).toBeGreaterThanOrEqual(1);
      expect(await mine()).toBe(0);
    });
  });
});
