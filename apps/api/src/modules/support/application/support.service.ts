import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import {
  APP_CONFIG,
  AppConfig,
  Clock,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  OBJECT_STORAGE,
  ObjectStorage,
  OutboxService,
  UnitOfWork,
  UploadType,
  ValidationFailedError,
  checkUpload,
  normalizeText,
  uuidv7,
} from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { BookingService, BookingSummaryService } from '../../booking';
import { AuthorizationService } from '../../identity-access';
import { SettingsService } from '../../platform';
import { ProviderAccessService } from '../../provider-management';

export const DISPUTE_CATEGORIES = ['SERVICE_NOT_DELIVERED', 'POOR_QUALITY', 'OVERCHARGED', 'STAFF_BEHAVIOUR', 'OTHER'] as const;
export const QUESTION_CATEGORIES = ['BOOKING', 'PAYMENT', 'ACCOUNT', 'TECHNICAL', 'OTHER'] as const;
export const OUTCOMES = ['RELEASE_TO_PROVIDER', 'REFUND_CUSTOMER', 'PARTIAL_REFUND'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type PartyRole = 'CUSTOMER' | 'PROVIDER';
const ALLOWED_EVIDENCE: readonly UploadType[] = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_ATTACHMENTS = 10;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

interface CaseRow {
  id: string;
  case_ref: string;
  kind: 'QUESTION' | 'DISPUTE';
  status: 'OPEN' | 'AWAITING_CUSTOMER' | 'AWAITING_PROVIDER' | 'IN_REVIEW' | 'RESOLVED' | 'CLOSED';
  opened_by: string;
  opened_by_role: PartyRole;
  customer_id: string | null;
  provider_id: string | null;
  booking_id: string | null;
  category: string;
  subject: string;
  assigned_to: string | null;
  resolution_outcome: Outcome | null;
  resolution_refund_minor: string | null;
  resolution_note: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}
interface MessageRow {
  id: string;
  author_role: 'CUSTOMER' | 'PROVIDER' | 'ADMIN' | 'SYSTEM';
  body: string;
  internal: boolean;
  created_at: Date;
}
interface AttachmentRow {
  id: string;
  uploaded_role: 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
  content_type: UploadType;
  size_bytes: number;
  original_name: string | null;
  created_at: Date;
  storage_key: string;
}
const CASE_COLUMNS = sql`id, case_ref, kind, status, opened_by, opened_by_role, customer_id, provider_id, booking_id, category, subject, assigned_to, resolution_outcome, resolution_refund_minor::text AS resolution_refund_minor, resolution_note, resolved_at, created_at, updated_at, closed_at`;

const caseView = (c: CaseRow) => ({
  id: c.id,
  reference: c.case_ref,
  kind: c.kind,
  status: c.status,
  category: c.category,
  subject: c.subject,
  booking_id: c.booking_id,
  opened_by_role: c.opened_by_role,
  assigned: c.assigned_to !== null,
  resolution: c.resolution_outcome ? { outcome: c.resolution_outcome, refund: { amount_minor: Number(c.resolution_refund_minor ?? 0), currency: 'INR' }, note: c.resolution_note, at: c.resolved_at!.toISOString() } : null,
  created_at: c.created_at.toISOString(),
  updated_at: c.updated_at.toISOString(),
  closed_at: c.closed_at ? c.closed_at.toISOString() : null,
});
const messageView = (m: MessageRow) => ({ id: m.id, author_role: m.author_role, body: m.body, created_at: m.created_at.toISOString() });
const attachmentView = (a: AttachmentRow) => ({ id: a.id, uploaded_by_role: a.uploaded_role, content_type: a.content_type, size_bytes: a.size_bytes, original_name: a.original_name, created_at: a.created_at.toISOString() });

function newReference(): string {
  const bytes = randomBytes(8);
  return `SUP-${Array.from(bytes, (b) => CROCKFORD[b % 32]).join('')}`;
}

/**
 * Customer support and disputes. A dispute freezes the booking's settlement (through the booking engine) and is closed only by
 * an administrator's decision, which the booking engine and the ledger carry out atomically. Everything a person writes is
 * stored as plain text; files are checked by content and only ever served as downloads through an authorised call.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly bookings: BookingService,
    private readonly summaries: BookingSummaryService,
    private readonly access: ProviderAccessService,
    private readonly authz: AuthorizationService,
    private readonly settings: SettingsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ===== opening =====================================================================================================
  async openDispute(customerId: string, bookingId: string, input: { category: unknown; message: unknown }) {
    if (!(await this.settings.get<boolean>('features.disputes_enabled'))) throw new ConflictError('DISPUTES_DISABLED', 'Disputes are switched off at the moment');
    const category = this.choose(input.category, DISPUTE_CATEGORIES, 'category');
    const message = this.required(input.message, 'message');
    const summary = await this.summaries.get(bookingId);
    if (!summary || summary.customerId !== customerId) throw new NotFoundError('Booking'); // not yours = does not exist

    const row = await this.uow.run(async () => {
      // The booking engine checks the state, the window and ownership, and freezes settlement, in this same transaction.
      await this.bookings.raiseDispute(customerId, bookingId);
      const now = this.clock.now();
      const id = uuidv7();
      const inserted = (
        await sql<CaseRow>`
          INSERT INTO support.cases (id, case_ref, kind, status, opened_by, opened_by_role, customer_id, provider_id, booking_id, category, subject, created_at, updated_at)
          VALUES (${id}::uuid, ${newReference()}, 'DISPUTE', 'OPEN', ${customerId}::uuid, 'CUSTOMER', ${customerId}::uuid, ${summary.providerId}::uuid, ${bookingId}::uuid, ${category}, ${`Dispute: ${summary.serviceName} (${summary.reference})`.slice(0, 140)}, ${now}, ${now})
          RETURNING ${CASE_COLUMNS}`.execute(this.uow.db<unknown>())
      ).rows[0]!;
      await this.addMessageRow(id, customerId, 'CUSTOMER', message, false);
      await this.outbox.publish({ type: 'support.case_opened', aggregateType: 'support_case', aggregateId: id, payload: { case_id: id, kind: 'DISPUTE', booking_id: bookingId, customer_id: customerId, provider_id: summary.providerId } });
      return inserted;
    });
    return caseView(row);
  }

  async openQuestion(userId: string, input: { audience: PartyRole; providerId?: string; bookingId?: string; category: unknown; subject: unknown; message: unknown }) {
    const category = this.choose(input.category, QUESTION_CATEGORIES, 'category');
    const subject = this.required(input.subject, 'subject', 140);
    if (subject.length < 3) throw new ValidationFailedError('subject must be at least 3 characters');
    const message = this.required(input.message, 'message');

    let customerId: string | null = null;
    let providerId: string | null = null;
    if (input.audience === 'PROVIDER') {
      if (!input.providerId) throw new ValidationFailedError('provider_id is required when writing as a business');
      await this.access.requireAtAnyScope(userId, 'support:contact', input.providerId);
      providerId = input.providerId;
    } else {
      customerId = userId;
    }
    if (input.bookingId) {
      const summary = await this.summaries.get(input.bookingId);
      const mine = summary && (input.audience === 'CUSTOMER' ? summary.customerId === userId : summary.providerId === providerId);
      if (!summary || !mine) throw new NotFoundError('Booking');
      customerId = summary.customerId;
      providerId = summary.providerId;
    }
    const row = await this.uow.run(async () => {
      const now = this.clock.now();
      const id = uuidv7();
      const inserted = (
        await sql<CaseRow>`
          INSERT INTO support.cases (id, case_ref, kind, status, opened_by, opened_by_role, customer_id, provider_id, booking_id, category, subject, created_at, updated_at)
          VALUES (${id}::uuid, ${newReference()}, 'QUESTION', 'OPEN', ${userId}::uuid, ${input.audience}, ${customerId}::uuid, ${providerId}::uuid, ${input.bookingId ?? null}::uuid, ${category}, ${subject}, ${now}, ${now})
          RETURNING ${CASE_COLUMNS}`.execute(this.uow.db<unknown>())
      ).rows[0]!;
      await this.addMessageRow(id, userId, input.audience, message, false);
      await this.outbox.publish({ type: 'support.case_opened', aggregateType: 'support_case', aggregateId: id, payload: { case_id: id, kind: 'QUESTION', booking_id: input.bookingId ?? null, customer_id: customerId, provider_id: providerId } });
      return inserted;
    });
    return caseView(row);
  }

  // ===== participants ================================================================================================
  async listMine(userId: string, q: { audience: PartyRole; providerId?: string; status?: string; cursor?: string; limit: number }) {
    if (q.audience === 'PROVIDER') {
      if (!q.providerId) throw new ValidationFailedError('provider_id is required when listing as a business');
      await this.access.requireAtAnyScope(userId, 'support:contact', q.providerId);
    }
    // A dispute is shared by both sides; a question stays with the side that asked it.
    const party =
      q.audience === 'CUSTOMER'
        ? sql`(customer_id = ${userId}::uuid OR opened_by = ${userId}::uuid) AND (kind = 'DISPUTE' OR opened_by_role = 'CUSTOMER')`
        : sql`provider_id = ${q.providerId}::uuid AND (kind = 'DISPUTE' OR opened_by_role = 'PROVIDER')`;
    const rows = (
      await sql<CaseRow>`
        SELECT ${CASE_COLUMNS} FROM support.cases
         WHERE (${party}) AND (${q.status ?? null}::text IS NULL OR status = ${q.status ?? null})
           AND (${q.cursor ?? null}::uuid IS NULL OR id < ${q.cursor ?? null}::uuid)
         ORDER BY id DESC LIMIT ${q.limit + 1}`.execute(this.uow.db<unknown>())
    ).rows;
    const page = rows.slice(0, q.limit);
    return { data: page.map(caseView), meta: { next_cursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null } };
  }

  async get(userId: string, caseId: string) {
    const { c, role } = await this.participant(userId, caseId);
    return this.detail(c, role, false);
  }

  async addMessage(userId: string, caseId: string, rawBody: unknown) {
    const body = this.required(rawBody, 'message');
    await this.uow.run(async () => {
      const { c, role } = await this.participant(userId, caseId, true);
      if (c.status === 'CLOSED' || c.status === 'RESOLVED') throw new ConflictError('CASE_CLOSED', 'This case is closed. Open a new one if you still need help.');
      const messageId = await this.addMessageRow(caseId, userId, role, body, false);
      // Answering a question that was waiting for this person puts the case back in the team's hands.
      const awaiting = role === 'CUSTOMER' ? 'AWAITING_CUSTOMER' : 'AWAITING_PROVIDER';
      await sql`UPDATE support.cases SET status = CASE WHEN status = ${awaiting} THEN 'IN_REVIEW' ELSE status END, updated_at = ${this.clock.now()} WHERE id = ${caseId}::uuid`.execute(this.uow.db<unknown>());
      await this.outbox.publish({ type: 'support.message_added', aggregateType: 'support_case', aggregateId: caseId, payload: { case_id: caseId, message_id: messageId, kind: c.kind, opened_by_role: c.opened_by_role, author_role: role, customer_id: c.customer_id, provider_id: c.provider_id } });
    });
    return this.get(userId, caseId);
  }

  async addAttachment(userId: string, caseId: string, file: { buffer?: Buffer; mimetype?: string; originalname?: string } | undefined) {
    const checked = checkUpload(file, { allowed: ALLOWED_EVIDENCE, maxBytes: this.config.storage.maxUploadBytes });
    const key = `case-evidence/${uuidv7()}`;
    await this.storage.put(key, checked.buffer, checked.type);
    try {
      const row = await this.uow.run(async () => {
        const { c, role } = await this.participant(userId, caseId, true);
        if (c.status === 'CLOSED' || c.status === 'RESOLVED') throw new ConflictError('CASE_CLOSED', 'This case is closed');
        const count = Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM support.attachments WHERE case_id = ${caseId}::uuid`.execute(this.uow.db<unknown>())).rows[0]!.n);
        if (count >= MAX_ATTACHMENTS) throw new ConflictError('TOO_MANY_ATTACHMENTS', `A case can hold at most ${MAX_ATTACHMENTS} files`);
        return this.insertAttachment(caseId, userId, role, key, checked, file?.originalname);
      });
      return attachmentView(row);
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
  }

  async downloadAttachment(userId: string, caseId: string, attachmentId: string) {
    await this.participant(userId, caseId);
    return this.readAttachment(caseId, attachmentId);
  }

  // ===== administrators (permission enforced by the route guard) =====================================================
  async adminList(q: { status?: string; kind?: string; assigned?: 'me' | 'none'; actorId: string; cursor?: string; limit: number }) {
    const rows = (
      await sql<CaseRow>`
        SELECT ${CASE_COLUMNS} FROM support.cases
         WHERE (${q.status ?? null}::text IS NULL OR status = ${q.status ?? null})
           AND (${q.kind ?? null}::text IS NULL OR kind = ${q.kind ?? null})
           AND (${q.assigned ?? null}::text IS NULL OR (${q.assigned ?? null} = 'me' AND assigned_to = ${q.actorId}::uuid) OR (${q.assigned ?? null} = 'none' AND assigned_to IS NULL))
           AND (${q.cursor ?? null}::uuid IS NULL OR id < ${q.cursor ?? null}::uuid)
         ORDER BY id DESC LIMIT ${q.limit + 1}`.execute(this.uow.db<unknown>())
    ).rows;
    const page = rows.slice(0, q.limit);
    return { data: page.map((c) => ({ ...caseView(c), customer_id: c.customer_id, provider_id: c.provider_id })), meta: { next_cursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null } };
  }

  async adminGet(actorId: string, caseId: string) {
    const c = await this.loadCase(caseId);
    const detail = await this.detail(c, 'ADMIN', true);
    const canResolveLarge = await this.authz.can(actorId, 'dispute:resolve_large');
    const limit = await this.settings.get<number>('disputes.operator_limit_minor');
    let booking = null;
    if (c.booking_id) {
      const s = await this.summaries.get(c.booking_id);
      if (s) booking = { id: s.id, reference: s.reference, status: s.status, service_name: s.serviceName, local_start: s.localStart, price: { amount_minor: Number(s.priceMinor), currency: s.currency }, held: { amount_minor: Number(s.grossMinor), currency: s.currency }, timeline: await this.summaries.timeline(c.booking_id) };
    }
    return { ...detail, customer_id: c.customer_id, provider_id: c.provider_id, assigned_to: c.assigned_to, booking, decision_limits: { operator_limit: { amount_minor: limit, currency: 'INR' }, can_decide_above_limit: canResolveLarge } };
  }

  async assign(actorId: string, caseId: string, assigneeId: string) {
    await this.uow.run(async () => {
      const c = await this.lockCase(caseId);
      if (c.status === 'CLOSED') throw new ConflictError('CASE_CLOSED', 'This case is closed');
      const assignee = (await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM identity.admin_credentials WHERE user_id = ${assigneeId}::uuid) AS ok`.execute(this.uow.db<unknown>())).rows[0]!.ok;
      if (!assignee) throw new ValidationFailedError('A case can only be assigned to a staff account');
      await sql`UPDATE support.cases SET assigned_to = ${assigneeId}::uuid, status = CASE WHEN status = 'OPEN' THEN 'IN_REVIEW' ELSE status END, updated_at = ${this.clock.now()} WHERE id = ${caseId}::uuid`.execute(this.uow.db<unknown>());
      await this.audit.record({ actorType: 'USER', actorId, action: 'support.case_assigned', entityType: 'support_case', entityId: caseId, before: { assigned_to: c.assigned_to }, after: { assigned_to: assigneeId } });
    });
    return this.adminGet(actorId, caseId);
  }

  /** A reply from staff (visible to the parties) or an internal note (administrators only). */
  async adminMessage(actorId: string, caseId: string, input: { body: unknown; internal?: boolean; awaiting?: 'CUSTOMER' | 'PROVIDER' | 'NONE' }) {
    const body = this.required(input.body, 'message');
    await this.uow.run(async () => {
      const c = await this.lockCase(caseId);
      if (c.status === 'CLOSED') throw new ConflictError('CASE_CLOSED', 'This case is closed');
      const messageId = await this.addMessageRow(caseId, actorId, 'ADMIN', body, input.internal === true);
      if (input.internal !== true) {
        const next = input.awaiting === 'CUSTOMER' ? 'AWAITING_CUSTOMER' : input.awaiting === 'PROVIDER' ? 'AWAITING_PROVIDER' : c.status === 'OPEN' ? 'IN_REVIEW' : c.status;
        await sql`UPDATE support.cases SET status = ${next}, updated_at = ${this.clock.now()} WHERE id = ${caseId}::uuid`.execute(this.uow.db<unknown>());
        await this.outbox.publish({ type: 'support.message_added', aggregateType: 'support_case', aggregateId: caseId, payload: { case_id: caseId, message_id: messageId, kind: c.kind, opened_by_role: c.opened_by_role, author_role: 'ADMIN', customer_id: c.customer_id, provider_id: c.provider_id } });
      }
    });
    return this.adminGet(actorId, caseId);
  }

  async adminAttachment(actorId: string, caseId: string, attachmentId: string) {
    await this.loadCase(caseId);
    const f = await this.readAttachment(caseId, attachmentId);
    await this.audit.record({ actorType: 'USER', actorId, action: 'support.attachment_viewed', entityType: 'support_case', entityId: caseId, metadata: { attachment_id: attachmentId } });
    return f;
  }

  /**
   * The decision on a dispute. The money is decided by the booking engine and the ledger in THIS transaction (all or nothing):
   * the refund can never exceed what was held, and the same decision can never be applied twice. Above the operator limit it
   * needs a different permission, so a support operator cannot decide a large refund alone.
   */
  async resolveDispute(actorId: string, caseId: string, input: { outcome: unknown; refundMinor?: unknown; note: unknown }) {
    const outcome = this.choose(input.outcome, OUTCOMES, 'outcome');
    const note = this.required(input.note, 'note', 1000);
    if (note.length < 10) throw new ValidationFailedError('note must explain the decision (at least 10 characters)');
    const result = await this.uow.run(async () => {
      const c = await this.lockCase(caseId);
      if (c.kind !== 'DISPUTE' || !c.booking_id) throw new ConflictError('NOT_A_DISPUTE', 'Only a dispute can be decided');
      if (c.status === 'RESOLVED' || c.status === 'CLOSED') throw new ConflictError('DISPUTE_ALREADY_RESOLVED', 'This dispute has already been decided');
      const summary = await this.summaries.get(c.booking_id);
      if (!summary) throw new NotFoundError('Booking');
      const gross = summary.grossMinor;
      const refundMinor = this.refundFor(outcome, input.refundMinor, gross);

      const limit = BigInt(await this.settings.get<number>('disputes.operator_limit_minor'));
      if (refundMinor > limit && !(await this.authz.can(actorId, 'dispute:resolve_large'))) {
        throw new ForbiddenError('This refund is above your limit. Assign the case to a platform administrator to decide it.', 'DISPUTE_LIMIT_EXCEEDED');
      }

      const money = await this.bookings.resolveDispute(actorId, c.booking_id, { refundMinor });
      const now = this.clock.now();
      await sql`
        UPDATE support.cases
           SET status = 'RESOLVED', resolution_outcome = ${outcome}, resolution_refund_minor = ${money.refundMinor.toString()}::bigint, resolution_note = ${note},
               resolved_by = ${actorId}::uuid, resolved_at = ${now}, updated_at = ${now}
         WHERE id = ${caseId}::uuid`.execute(this.uow.db<unknown>());
      await this.addMessageRow(caseId, actorId, 'ADMIN', `Decision: ${outcome.replace(/_/g, ' ').toLowerCase()}. ${note}`, false);
      await this.audit.record({ actorType: 'USER', actorId, action: 'support.dispute_resolved', entityType: 'support_case', entityId: caseId, before: { status: c.status }, after: { status: 'RESOLVED', outcome }, metadata: { booking_id: c.booking_id, refund_minor: Number(money.refundMinor), provider_net_minor: Number(money.providerNetMinor), commission_minor: Number(money.commissionMinor), note } });
      await this.outbox.publish({ type: 'support.dispute_resolved', aggregateType: 'support_case', aggregateId: caseId, payload: { case_id: caseId, booking_id: c.booking_id, kind: c.kind, outcome, refund_minor: Number(money.refundMinor), customer_id: c.customer_id, provider_id: c.provider_id } });
      return money;
    });
    return { ...(await this.adminGet(actorId, caseId)), money: { refund: { amount_minor: Number(result.refundMinor), currency: result.currency }, provider_net: { amount_minor: Number(result.providerNetMinor), currency: result.currency }, commission: { amount_minor: Number(result.commissionMinor), currency: result.currency } } };
  }

  /** Closes a question, or an already-decided dispute. A dispute that has NOT been decided cannot be closed (its money is frozen). */
  async close(actorId: string, caseId: string, note?: unknown) {
    const text = normalizeText(note, 'note', 1000);
    await this.uow.run(async () => {
      const c = await this.lockCase(caseId);
      if (c.status === 'CLOSED') throw new ConflictError('CASE_CLOSED', 'This case is already closed');
      if (c.kind === 'DISPUTE' && c.status !== 'RESOLVED') throw new ConflictError('DISPUTE_UNDECIDED', 'A dispute must be decided before it can be closed');
      const now = this.clock.now();
      await sql`UPDATE support.cases SET status = 'CLOSED', closed_at = ${now}, updated_at = ${now} WHERE id = ${caseId}::uuid`.execute(this.uow.db<unknown>());
      if (text) await this.addMessageRow(caseId, actorId, 'ADMIN', text, false);
      await this.audit.record({ actorType: 'USER', actorId, action: 'support.case_closed', entityType: 'support_case', entityId: caseId, before: { status: c.status }, after: { status: 'CLOSED' } });
    });
    return this.adminGet(actorId, caseId);
  }

  // ===== internals ===================================================================================================
  private refundFor(outcome: Outcome, raw: unknown, gross: bigint): bigint {
    if (outcome === 'RELEASE_TO_PROVIDER') return 0n;
    if (outcome === 'REFUND_CUSTOMER') return gross;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new ValidationFailedError('refund_minor is required (whole paise) for a partial refund');
    const refund = BigInt(raw);
    if (refund <= 0n || refund >= gross) throw new ValidationFailedError(`A partial refund must be more than 0 and less than ${gross} paise (the amount held)`);
    return refund;
  }

  private choose<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
    if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) throw new ValidationFailedError(`${field} must be one of ${allowed.join(', ')}`);
    return raw as T;
  }

  private required(raw: unknown, field: string, max = 2000): string {
    const text = normalizeText(raw, field, max);
    if (!text) throw new ValidationFailedError(`${field} is required`);
    return text;
  }

  private async addMessageRow(caseId: string, authorId: string | null, role: 'CUSTOMER' | 'PROVIDER' | 'ADMIN' | 'SYSTEM', body: string, internal: boolean): Promise<string> {
    const id = uuidv7();
    await sql`INSERT INTO support.messages (id, case_id, author_id, author_role, body, internal, created_at) VALUES (${id}::uuid, ${caseId}::uuid, ${authorId}::uuid, ${role}, ${body}, ${internal}, ${this.clock.now()})`.execute(this.uow.db<unknown>());
    return id;
  }

  private async insertAttachment(caseId: string, userId: string, role: PartyRole, key: string, checked: { type: UploadType; size: number; sha256: string }, originalName: string | undefined) {
    const name = originalName ? (originalName.split(/[\\/]/).pop() ?? '').replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 100) || null : null;
    return (
      await sql<AttachmentRow>`
        INSERT INTO support.attachments (id, case_id, uploaded_by, uploaded_role, storage_key, content_type, size_bytes, sha256, original_name, created_at)
        VALUES (${uuidv7()}::uuid, ${caseId}::uuid, ${userId}::uuid, ${role}, ${key}, ${checked.type}, ${checked.size}, ${checked.sha256}, ${name}, ${this.clock.now()})
        RETURNING id, uploaded_role, content_type, size_bytes, original_name, created_at, storage_key`.execute(this.uow.db<unknown>())
    ).rows[0]!;
  }

  private async readAttachment(caseId: string, attachmentId: string) {
    const row = (await sql<AttachmentRow>`SELECT id, uploaded_role, content_type, size_bytes, original_name, created_at, storage_key FROM support.attachments WHERE id = ${attachmentId}::uuid AND case_id = ${caseId}::uuid`.execute(this.uow.db<unknown>())).rows[0];
    if (!row) throw new NotFoundError('Attachment');
    const stored = await this.storage.get(row.storage_key);
    if (!stored) throw new NotFoundError('Attachment file');
    return { body: stored.body, contentType: row.content_type, fileName: `evidence.${row.content_type === 'application/pdf' ? 'pdf' : row.content_type === 'image/png' ? 'png' : 'jpg'}` };
  }

  private async detail(c: CaseRow, viewer: 'CUSTOMER' | 'PROVIDER' | 'ADMIN', staff: boolean) {
    const db = this.uow.db<unknown>();
    const messages = (await sql<MessageRow>`SELECT id, author_role, body, internal, created_at FROM support.messages WHERE case_id = ${c.id}::uuid AND (${staff} OR internal = FALSE) ORDER BY id`.execute(db)).rows;
    const attachments = (await sql<AttachmentRow>`SELECT id, uploaded_role, content_type, size_bytes, original_name, created_at, storage_key FROM support.attachments WHERE case_id = ${c.id}::uuid ORDER BY created_at, id`.execute(db)).rows;
    return {
      ...caseView(c),
      viewer_role: viewer,
      messages: messages.map((m) => (staff ? { ...messageView(m), internal: m.internal } : messageView(m))),
      attachments: attachments.map(attachmentView),
    };
  }

  private async loadCase(caseId: string): Promise<CaseRow> {
    const row = (await sql<CaseRow>`SELECT ${CASE_COLUMNS} FROM support.cases WHERE id = ${caseId}::uuid`.execute(this.uow.db<unknown>())).rows[0];
    if (!row) throw new NotFoundError('Case');
    return row;
  }

  private async lockCase(caseId: string): Promise<CaseRow> {
    const row = (await sql<CaseRow>`SELECT ${CASE_COLUMNS} FROM support.cases WHERE id = ${caseId}::uuid FOR UPDATE`.execute(this.uow.db<unknown>())).rows[0];
    if (!row) throw new NotFoundError('Case');
    return row;
  }

  /** Which side of the case is this person on? Anyone who is on neither side gets a 404: the case's existence is not disclosed. */
  private async participant(userId: string, caseId: string, lock = false): Promise<{ c: CaseRow; role: PartyRole }> {
    const c = lock ? await this.lockCase(caseId) : await this.loadCase(caseId);
    const onlyOpener = c.kind === 'QUESTION' ? c.opened_by_role : null; // a question is private to the side that asked it
    if (onlyOpener !== 'PROVIDER' && (c.customer_id === userId || (c.opened_by === userId && c.opened_by_role === 'CUSTOMER'))) return { c, role: 'CUSTOMER' };
    if (onlyOpener !== 'CUSTOMER' && c.provider_id) {
      try {
        await this.access.requireAtAnyScope(userId, 'support:contact', c.provider_id);
        return { c, role: 'PROVIDER' };
      } catch {
        /* not on the business side either */
      }
    }
    throw new NotFoundError('Case');
  }
}
