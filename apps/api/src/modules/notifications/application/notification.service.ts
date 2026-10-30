import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock, FIELD_CIPHER, FieldCipher, NotFoundError, OutboxService, PII_HASH_KEY, UnitOfWork, ValidationFailedError, hmacSha256Hex, uuidv7 } from '../../../shared-kernel';
import { Audience, CATEGORIES, Category, Draft } from '../domain/templates';
import { PushProvider } from '../infrastructure/push-provider';

export interface NotificationView {
  id: string;
  audience: Audience;
  category: Category;
  kind: string;
  title: string;
  body: string;
  data: Record<string, string>;
  created_at: string;
  read_at: string | null;
}

interface Row {
  id: string;
  audience: Audience;
  category: Category;
  kind: string;
  title: string;
  body: string;
  data: Record<string, string>;
  created_at: Date;
  read_at: Date | null;
}

const toView = (r: Row): NotificationView => ({ id: r.id, audience: r.audience, category: r.category, kind: r.kind, title: r.title, body: r.body, data: r.data, created_at: r.created_at.toISOString(), read_at: r.read_at ? r.read_at.toISOString() : null });

/**
 * Notifications: created from business events, listed in the apps, and pushed to registered devices. Creating one never fails
 * the thing that caused it (callers are outbox consumers, retried independently of any booking or ledger transaction).
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly push: PushProvider,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(PII_HASH_KEY) private readonly hashKey: Buffer,
  ) {}

  /**
   * Stores one notification per (user, dedupe key) — a retried event is a no-op — and queues a push delivery for each of the
   * person's devices that belongs to the right app and has not muted the category. Inactive accounts get nothing.
   * Returns how many NEW notifications were created.
   */
  async notify(items: { userId: string; draft: Draft }[]): Promise<number> {
    if (items.length === 0) return 0;
    return this.uow.run(async () => {
      const db = this.uow.db<unknown>();
      const now = this.clock.now();
      let created = 0;
      for (const { userId, draft } of items) {
        const id = uuidv7();
        const inserted = (
          await sql<{ id: string }>`
            INSERT INTO notification.notifications (id, user_id, audience, category, kind, title, body, data, dedupe_key, created_at)
            SELECT ${id}::uuid, u.id, ${draft.audience}, ${draft.category}, ${draft.kind}, ${draft.title}, ${draft.body}, ${JSON.stringify(draft.data)}::jsonb, ${draft.dedupeKey}, ${now}
              FROM identity.users u WHERE u.id = ${userId}::uuid AND u.status = 'ACTIVE'
            ON CONFLICT (user_id, dedupe_key) DO NOTHING
            RETURNING id`.execute(db)
        ).rows[0];
        if (!inserted) continue;
        created++;
        if (!this.push.enabled) continue;
        const queued = (
          await sql<{ id: string }>`
            INSERT INTO notification.deliveries (id, notification_id, channel, device_id, status, created_at)
            SELECT gen_random_uuid(), ${id}::uuid, 'PUSH', d.id, 'PENDING', ${now}
              FROM notification.devices d
             WHERE d.user_id = ${userId}::uuid AND d.app = ${draft.audience} AND d.revoked_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM notification.preferences p WHERE p.user_id = d.user_id AND p.category = ${draft.category} AND p.push_enabled = FALSE)
            RETURNING id`.execute(db)
        ).rows;
        if (queued.length > 0) await this.outbox.publish({ type: 'notification.deliver', aggregateType: 'notification', aggregateId: id, payload: { notification_id: id } });
      }
      return created;
    });
  }

  // ---- the person's own inbox ---------------------------------------------------------------------------------------------
  async list(userId: string, q: { audience: Audience; unreadOnly: boolean; cursor?: string; limit: number }) {
    const rows = (
      await sql<Row>`
        SELECT id, audience, category, kind, title, body, data, created_at, read_at
          FROM notification.notifications
         WHERE user_id = ${userId}::uuid AND audience = ${q.audience}
           AND (${q.unreadOnly} = FALSE OR read_at IS NULL)
           AND (${q.cursor ?? null}::uuid IS NULL OR id < ${q.cursor ?? null}::uuid)
         ORDER BY id DESC LIMIT ${q.limit + 1}`.execute(this.uow.db<unknown>())
    ).rows;
    const page = rows.slice(0, q.limit);
    return { data: page.map(toView), meta: { next_cursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null } };
  }

  async unreadCount(userId: string, audience: Audience): Promise<number> {
    const r = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM notification.notifications WHERE user_id = ${userId}::uuid AND audience = ${audience} AND read_at IS NULL`.execute(this.uow.db<unknown>())).rows[0]!;
    return Number(r.n);
  }

  /** Marking someone else's (or a missing) notification is a 404: its existence is not disclosed. */
  async markRead(userId: string, id: string): Promise<NotificationView> {
    const row = (
      await sql<Row>`
        UPDATE notification.notifications SET read_at = COALESCE(read_at, ${this.clock.now()})
         WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
        RETURNING id, audience, category, kind, title, body, data, created_at, read_at`.execute(this.uow.db<unknown>())
    ).rows[0];
    if (!row) throw new NotFoundError('Notification');
    return toView(row);
  }

  async markAllRead(userId: string, audience: Audience): Promise<number> {
    const res = await sql`UPDATE notification.notifications SET read_at = ${this.clock.now()} WHERE user_id = ${userId}::uuid AND audience = ${audience} AND read_at IS NULL`.execute(this.uow.db<unknown>());
    return Number(res.numAffectedRows ?? 0);
  }

  // ---- devices ----------------------------------------------------------------------------------------------------------
  /** Registers (or re-registers) a push token for the signed-in person. A token that moves to a different account moves with it. */
  async registerDevice(userId: string, input: { app: Audience; platform: 'ANDROID' | 'IOS'; token: string; locale?: string }): Promise<{ id: string }> {
    const token = input.token.trim();
    if (token.length < 16 || token.length > 4096) throw new ValidationFailedError('The push token looks invalid');
    const now = this.clock.now();
    const row = (
      await sql<{ id: string }>`
        INSERT INTO notification.devices (id, user_id, app, platform, token_hash, token_enc, locale, created_at, last_seen_at)
        VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${input.app}, ${input.platform}, ${this.tokenHash(token)}, ${this.cipher.encrypt(token)}, ${input.locale ?? null}, ${now}, ${now})
        ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, app = EXCLUDED.app, platform = EXCLUDED.platform, locale = EXCLUDED.locale, last_seen_at = EXCLUDED.last_seen_at, revoked_at = NULL
        RETURNING id`.execute(this.uow.db<unknown>())
    ).rows[0]!;
    return row;
  }

  /** Called at sign-out so the next person on a shared phone does not receive this person's notifications. */
  async unregisterDevice(userId: string, token: string): Promise<boolean> {
    const res = await sql`UPDATE notification.devices SET revoked_at = ${this.clock.now()} WHERE token_hash = ${this.tokenHash(token.trim())} AND user_id = ${userId}::uuid AND revoked_at IS NULL`.execute(this.uow.db<unknown>());
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  // ---- preferences ------------------------------------------------------------------------------------------------------
  async preferences(userId: string): Promise<{ category: Category; push_enabled: boolean }[]> {
    const rows = (await sql<{ category: Category; push_enabled: boolean }>`SELECT category, push_enabled FROM notification.preferences WHERE user_id = ${userId}::uuid`.execute(this.uow.db<unknown>())).rows;
    const byCategory = new Map(rows.map((r) => [r.category, r.push_enabled]));
    return CATEGORIES.map((category) => ({ category, push_enabled: byCategory.get(category) ?? true }));
  }

  async setPreference(userId: string, category: Category, pushEnabled: boolean) {
    await sql`
      INSERT INTO notification.preferences (user_id, category, push_enabled) VALUES (${userId}::uuid, ${category}, ${pushEnabled})
      ON CONFLICT (user_id, category) DO UPDATE SET push_enabled = EXCLUDED.push_enabled`.execute(this.uow.db<unknown>());
    return this.preferences(userId);
  }

  /** Deletes everything the notification module holds about a person (account deletion). */
  async eraseUser(userId: string): Promise<void> {
    const db = this.uow.db<unknown>();
    await sql`DELETE FROM notification.deliveries WHERE notification_id IN (SELECT id FROM notification.notifications WHERE user_id = ${userId}::uuid)`.execute(db);
    await sql`DELETE FROM notification.deliveries WHERE device_id IN (SELECT id FROM notification.devices WHERE user_id = ${userId}::uuid)`.execute(db);
    await sql`DELETE FROM notification.notifications WHERE user_id = ${userId}::uuid`.execute(db);
    await sql`DELETE FROM notification.devices WHERE user_id = ${userId}::uuid`.execute(db);
    await sql`DELETE FROM notification.preferences WHERE user_id = ${userId}::uuid`.execute(db);
  }

  private tokenHash(token: string): string {
    return hmacSha256Hex(this.hashKey, `push:${token}`);
  }
}
