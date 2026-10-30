import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { Clock, DatabaseService, FIELD_CIPHER, FieldCipher, LOGGER } from '../../../shared-kernel';
import { PushProvider } from '../infrastructure/push-provider';

/** After this many failed tries a delivery is given up on (the in-app notification is unaffected). */
export const MAX_DELIVERY_ATTEMPTS = 5;

interface Pending {
  delivery_id: string;
  attempts: number;
  device_id: string;
  token_enc: Buffer;
  revoked_at: Date | null;
  notification_id: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * Sends the queued pushes for one notification.
 *
 * The outbox dispatcher runs every consumer inside a transaction that ROLLS BACK when the consumer throws (which is how we ask
 * for a retry). Delivery bookkeeping therefore goes through its OWN connection, not the ambient transaction: a push that was
 * SENT stays recorded as SENT even when a sibling device needs another try, so a retry resends only what is still PENDING and
 * never pushes twice to a device that already has the message. (If the process dies between sending and recording, the retry
 * can repeat that one push; the push carries the notification id as its collapse tag, so the device shows it once.)
 */
@Injectable()
export class DeliveryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: Clock,
    private readonly push: PushProvider,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Throws when at least one delivery needs another try, so the outbox retries the event with backoff. */
  async deliver(notificationId: string): Promise<{ sent: number; failed: number; retry: number }> {
    const db = this.database.kysely; // independent of the ambient (rollback-on-retry) transaction, see above
    const pending = (
      await sql<Pending>`
        SELECT d.id AS delivery_id, d.attempts, dev.id AS device_id, dev.token_enc, dev.revoked_at,
               n.id AS notification_id, n.kind, n.title, n.body, n.data
          FROM notification.deliveries d
          JOIN notification.devices dev ON dev.id = d.device_id
          JOIN notification.notifications n ON n.id = d.notification_id
         WHERE d.notification_id = ${notificationId}::uuid AND d.status = 'PENDING' AND d.channel = 'PUSH'`.execute(db)
    ).rows;

    let sent = 0;
    let failed = 0;
    let retry = 0;
    for (const p of pending) {
      const now = this.clock.now();
      if (p.revoked_at) {
        await sql`UPDATE notification.deliveries SET status = 'SKIPPED', last_error = 'device signed out' WHERE id = ${p.delivery_id}::uuid`.execute(db);
        continue;
      }
      const result = await this.push.send({ token: this.cipher.decrypt(p.token_enc), title: p.title, body: p.body, data: { ...p.data, notification_id: p.notification_id, kind: p.kind } });
      switch (result.kind) {
        case 'SENT':
          sent++;
          await sql`UPDATE notification.deliveries SET status = 'SENT', attempts = attempts + 1, sent_at = ${now}, provider_message_id = ${result.messageId}, last_error = NULL WHERE id = ${p.delivery_id}::uuid`.execute(db);
          break;
        case 'INVALID_TOKEN':
          failed++;
          await sql`UPDATE notification.deliveries SET status = 'FAILED', attempts = attempts + 1, last_error = 'device token is no longer valid' WHERE id = ${p.delivery_id}::uuid`.execute(db);
          await sql`UPDATE notification.devices SET revoked_at = ${now} WHERE id = ${p.device_id}::uuid AND revoked_at IS NULL`.execute(db);
          break;
        case 'REJECTED':
          failed++;
          await sql`UPDATE notification.deliveries SET status = 'FAILED', attempts = attempts + 1, last_error = ${result.reason.slice(0, 300)} WHERE id = ${p.delivery_id}::uuid`.execute(db);
          break;
        case 'RETRY': {
          const attempts = p.attempts + 1;
          if (attempts >= MAX_DELIVERY_ATTEMPTS) {
            failed++;
            await sql`UPDATE notification.deliveries SET status = 'FAILED', attempts = ${attempts}, last_error = ${`gave up: ${result.reason}`.slice(0, 300)} WHERE id = ${p.delivery_id}::uuid`.execute(db);
          } else {
            retry++;
            await sql`UPDATE notification.deliveries SET attempts = ${attempts}, last_error = ${result.reason.slice(0, 300)} WHERE id = ${p.delivery_id}::uuid`.execute(db);
          }
          break;
        }
      }
    }
    this.logger.debug({ notification_id: notificationId, sent, failed, retry }, 'push deliveries processed');
    if (retry > 0) throw new Error(`${retry} push deliver${retry === 1 ? 'y' : 'ies'} to retry`);
    return { sent, failed, retry };
  }
}
