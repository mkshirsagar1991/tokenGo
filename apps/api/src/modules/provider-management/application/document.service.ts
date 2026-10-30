import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  APP_CONFIG,
  AppConfig,
  Clock,
  ConflictError,
  NotFoundError,
  OBJECT_STORAGE,
  ObjectStorage,
  UnitOfWork,
  UploadType,
  ValidationFailedError,
  checkUpload,
  uuidv7,
} from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { ProviderAccessService } from './provider-access.service';

export const DOCUMENT_TYPES = ['ID_PROOF', 'BUSINESS_REGISTRATION', 'ADDRESS_PROOF', 'TAX_REGISTRATION', 'OTHER'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
const ALLOWED: readonly UploadType[] = ['image/jpeg', 'image/png', 'application/pdf'];

interface Row {
  id: string;
  provider_id: string;
  doc_type: DocumentType;
  status: 'UPLOADED' | 'VERIFIED' | 'REJECTED';
  storage_key: string;
  content_type: UploadType;
  size_bytes: number;
  original_name: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  review_note: string | null;
}
const COLUMNS = sql`id, provider_id, doc_type, status, storage_key, content_type, size_bytes, original_name, created_at, reviewed_at, review_note`;

/** Never exposes the storage key or hash: the file is only reachable through an authorised download. */
const view = (r: Row) => ({
  id: r.id,
  provider_id: r.provider_id,
  doc_type: r.doc_type,
  status: r.status,
  content_type: r.content_type,
  size_bytes: r.size_bytes,
  original_name: r.original_name,
  uploaded_at: r.created_at.toISOString(),
  reviewed_at: r.reviewed_at ? r.reviewed_at.toISOString() : null,
  review_note: r.review_note,
});

/** A display name from whatever the client sent: no path, no control characters, bounded length. */
export function cleanFileName(raw: string | undefined): string | null {
  if (!raw) return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001F\u007F<>:"|?*]/g, '').trim().slice(0, 100);
  return name === '' ? null : name;
}

@Injectable()
export class DocumentService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly access: ProviderAccessService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ===== the business ================================================================================================
  async upload(userId: string, providerId: string, input: { docType: unknown; file: { buffer?: Buffer; mimetype?: string; originalname?: string } | undefined }) {
    await this.access.require(userId, 'document:manage', providerId);
    if (typeof input.docType !== 'string' || !(DOCUMENT_TYPES as readonly string[]).includes(input.docType)) throw new ValidationFailedError(`doc_type must be one of ${DOCUMENT_TYPES.join(', ')}`);
    const checked = checkUpload(input.file, { allowed: ALLOWED, maxBytes: this.config.storage.maxUploadBytes });
    const id = uuidv7();
    const key = `provider-documents/${uuidv7()}`;
    // Store first: an orphaned object (if the insert fails) is harmless and invisible; a row pointing at nothing is not.
    await this.storage.put(key, checked.buffer, checked.type);
    try {
      const row = await this.uow.run(async () => {
        const count = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM provider.documents WHERE provider_id = ${providerId}::uuid AND deleted_at IS NULL`.execute(this.uow.db<unknown>())).rows[0]!.n;
        if (Number(count) >= 20) throw new ConflictError('TOO_MANY_DOCUMENTS', 'A business can keep at most 20 documents. Delete one first.');
        const inserted = (
          await sql<Row>`
            INSERT INTO provider.documents (id, provider_id, doc_type, storage_key, content_type, size_bytes, sha256, original_name, uploaded_by, created_at)
            VALUES (${id}::uuid, ${providerId}::uuid, ${input.docType}, ${key}, ${checked.type}, ${checked.size}, ${checked.sha256}, ${cleanFileName(input.file?.originalname)}, ${userId}::uuid, ${this.clock.now()})
            RETURNING ${COLUMNS}`.execute(this.uow.db<unknown>())
        ).rows[0]!;
        await this.audit.record({ actorType: 'USER', actorId: userId, action: 'provider.document_uploaded', entityType: 'provider_document', entityId: id, metadata: { provider_id: providerId, doc_type: input.docType, size_bytes: checked.size, content_type: checked.type } });
        return inserted;
      });
      return view(row);
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
  }

  async list(userId: string, providerId: string) {
    await this.access.require(userId, 'document:manage', providerId);
    return this.listFor(providerId);
  }

  async download(userId: string, providerId: string, documentId: string) {
    await this.access.require(userId, 'document:manage', providerId);
    return this.fetch(documentId, providerId);
  }

  async remove(userId: string, providerId: string, documentId: string): Promise<void> {
    await this.access.require(userId, 'document:manage', providerId);
    await this.uow.run(async () => {
      const row = await this.lock(documentId, providerId);
      if (row.status === 'VERIFIED') throw new ConflictError('DOCUMENT_VERIFIED', 'A verified document cannot be deleted. Contact support if it is wrong.');
      await sql`UPDATE provider.documents SET deleted_at = ${this.clock.now()} WHERE id = ${documentId}::uuid`.execute(this.uow.db<unknown>());
      await this.audit.record({ actorType: 'USER', actorId: userId, action: 'provider.document_deleted', entityType: 'provider_document', entityId: documentId, metadata: { provider_id: providerId } });
    });
    // The object itself is removed after the row is gone from view (best effort; a leftover object is unreachable).
    const row = (await sql<{ storage_key: string }>`SELECT storage_key FROM provider.documents WHERE id = ${documentId}::uuid`.execute(this.uow.db<unknown>())).rows[0];
    if (row) await this.storage.delete(row.storage_key).catch(() => undefined);
  }

  /** Submission check: has the business uploaded anything at all? */
  async count(providerId: string): Promise<number> {
    return Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM provider.documents WHERE provider_id = ${providerId}::uuid AND deleted_at IS NULL`.execute(this.uow.db<unknown>())).rows[0]!.n);
  }

  // ===== administrators (permission enforced by the route guard) =====================================================
  async adminList(providerId: string) {
    return this.listFor(providerId);
  }

  /** Opening a document is itself audited: who looked at someone's identity papers, and when. */
  async adminDownload(actorId: string, documentId: string) {
    const doc = await this.fetch(documentId, undefined);
    await this.audit.record({ actorType: 'USER', actorId, action: 'provider.document_viewed', entityType: 'provider_document', entityId: documentId, metadata: { provider_id: doc.providerId } });
    return doc;
  }

  async decide(actorId: string, documentId: string, decision: 'VERIFIED' | 'REJECTED', note?: string) {
    if (decision === 'REJECTED' && (!note || note.trim().length < 3)) throw new ValidationFailedError('Say what is wrong with the document so the business can fix it');
    const row = await this.uow.run(async () => {
      const current = await this.lock(documentId, undefined);
      if (current.status !== 'UPLOADED') throw new ConflictError('DOCUMENT_ALREADY_DECIDED', `This document was already ${current.status.toLowerCase()}`);
      const now = this.clock.now();
      const updated = (
        await sql<Row>`UPDATE provider.documents SET status = ${decision}, reviewed_by = ${actorId}::uuid, reviewed_at = ${now}, review_note = ${note?.trim() ?? null} WHERE id = ${documentId}::uuid RETURNING ${COLUMNS}`.execute(this.uow.db<unknown>())
      ).rows[0]!;
      await this.audit.record({ actorType: 'USER', actorId, action: decision === 'VERIFIED' ? 'provider.document_verified' : 'provider.document_rejected', entityType: 'provider_document', entityId: documentId, before: { status: 'UPLOADED' }, after: { status: decision }, metadata: { provider_id: updated.provider_id, note: note?.trim() ?? null } });
      return updated;
    });
    return view(row);
  }

  // ===== internals ===================================================================================================
  private async listFor(providerId: string) {
    const rows = (await sql<Row>`SELECT ${COLUMNS} FROM provider.documents WHERE provider_id = ${providerId}::uuid AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`.execute(this.uow.db<unknown>())).rows;
    return rows.map(view);
  }

  private async lock(documentId: string, providerId: string | undefined): Promise<Row> {
    const row = (
      await sql<Row>`SELECT ${COLUMNS} FROM provider.documents WHERE id = ${documentId}::uuid AND deleted_at IS NULL AND (${providerId ?? null}::uuid IS NULL OR provider_id = ${providerId ?? null}::uuid) FOR UPDATE`.execute(this.uow.db<unknown>())
    ).rows[0];
    if (!row) throw new NotFoundError('Document');
    return row;
  }

  private async fetch(documentId: string, providerId: string | undefined) {
    const row = (
      await sql<Row>`SELECT ${COLUMNS} FROM provider.documents WHERE id = ${documentId}::uuid AND deleted_at IS NULL AND (${providerId ?? null}::uuid IS NULL OR provider_id = ${providerId ?? null}::uuid)`.execute(this.uow.db<unknown>())
    ).rows[0];
    if (!row) throw new NotFoundError('Document');
    const stored = await this.storage.get(row.storage_key);
    if (!stored) throw new NotFoundError('Document file');
    return { providerId: row.provider_id, body: stored.body, contentType: row.content_type, fileName: `${row.doc_type.toLowerCase()}.${row.content_type === 'application/pdf' ? 'pdf' : row.content_type === 'image/png' ? 'png' : 'jpg'}` };
  }
}
