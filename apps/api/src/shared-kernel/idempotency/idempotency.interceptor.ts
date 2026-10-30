import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, from, lastValueFrom } from 'rxjs';
import { Clock } from '../clock';
import { sha256Hex } from '../crypto';
import { UnitOfWork } from '../database';
import { ConflictError, DomainError, ValidationFailedError } from '../errors';
import { requestContext } from '../request-context';
import { stableStringify } from './stable-json';

const IDEMPOTENT_META = 'tokengo:idempotent';
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export interface IdempotentOptions {
  /** true => a missing `Idempotency-Key` header is rejected (money/booking commands). */
  required: boolean;
}

interface IdemDb {
  'platform.idempotency_records': {
    principal_id: string;
    scope: string;
    idempotency_key: string;
    request_hash: string;
    status: 'IN_PROGRESS' | 'COMPLETED';
    response_status: number | null;
    response_body: unknown;
    expires_at: Date;
  };
}

/** Keys are honoured for 48 h — comfortably longer than any sane client retry window. */
const RECORD_TTL_MS = 48 * 3_600_000;

/**
 * Makes a command safe to retry (docs §L.1 #1). Mark a route `@Idempotent()` and clients send an
 * `Idempotency-Key`. The first request runs; every retry with the same key + same payload returns the
 * ORIGINAL response (header `Idempotent-Replayed: true`) and performs no second effect.
 *
 * How it stays correct: the key is claimed INSIDE the same database transaction as the business work.
 *   - A concurrent duplicate blocks on the unique index until the first transaction finishes, then either
 *     replays the stored response (first committed) or runs itself (first rolled back).
 *   - "Effect committed but response not recorded" cannot happen: both commit together.
 *   - Failed requests roll back everything including the claim, so a retry after an error re-executes.
 *     (Idempotency applies to successful outcomes; clients should use a NEW key for a new intent.)
 *   - Same key with a DIFFERENT payload is a client bug -> 422, nothing executed.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reflector: Reflector,
    private readonly clock: Clock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT_META, context.getHandler());
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    if (!opts) return next.handle();

    const key = req.header('idempotency-key');
    if (key === undefined) {
      if (opts.required) throw new ValidationFailedError('The Idempotency-Key header is required for this operation', { fields: { 'idempotency-key': ['is required'] } });
      return next.handle();
    }
    if (!KEY_RE.test(key)) {
      throw new ValidationFailedError('Invalid Idempotency-Key', { fields: { 'idempotency-key': ['must be 8-128 chars of [A-Za-z0-9._:-]'] } });
    }
    const principal = requestContext.getStore()?.actorId;
    if (!principal) throw new DomainError('IDEMPOTENCY_MISCONFIGURED', 'Idempotent routes must be authenticated', 500);

    const scope = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    const requestHash = sha256Hex(stableStringify({ params: req.params, query: req.query, body: req.body }));

    return from(
      this.uow.run(async () => {
        const db = this.uow.db<IdemDb>();
        const claimed = await db
          .insertInto('platform.idempotency_records')
          .values({
            principal_id: principal,
            scope,
            idempotency_key: key,
            request_hash: requestHash,
            status: 'IN_PROGRESS',
            response_status: null,
            response_body: null,
            expires_at: new Date(this.clock.now().getTime() + RECORD_TTL_MS),
          })
          .onConflict((oc) => oc.columns(['principal_id', 'scope', 'idempotency_key']).doNothing())
          .executeTakeFirst();

        if (Number(claimed.numInsertedOrUpdatedRows ?? 0) === 0) {
          // Someone claimed this key (and, because the insert waited for them, has COMMITTED).
          const existing = await db
            .selectFrom('platform.idempotency_records')
            .select(['request_hash', 'status', 'response_status', 'response_body'])
            .where('principal_id', '=', principal)
            .where('scope', '=', scope)
            .where('idempotency_key', '=', key)
            .executeTakeFirstOrThrow();
          if (existing.request_hash !== requestHash) {
            throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request', 422);
          }
          if (existing.status !== 'COMPLETED') {
            throw new ConflictError('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
          }
          res.setHeader('Idempotent-Replayed', 'true');
          return existing.response_body;
        }

        const body = await lastValueFrom(next.handle());
        // Nest applies the final status AFTER interceptors run, so derive the intended one (replays re-use it).
        const httpCode = Reflect.getMetadata('__httpCode__', context.getHandler()) as number | undefined;
        await db
          .updateTable('platform.idempotency_records')
          .set({
            status: 'COMPLETED',
            response_status: httpCode ?? (req.method === 'POST' ? 201 : 200),
            response_body: JSON.stringify(body ?? null) as unknown,
          })
          .where('principal_id', '=', principal)
          .where('scope', '=', scope)
          .where('idempotency_key', '=', key)
          .execute();
        return body;
      }),
    );
  }
}

/** `@Idempotent()` (optional header) or `@Idempotent({ required: true })` for money/booking commands. */
export const Idempotent = (options: IdempotentOptions = { required: false }) =>
  applyDecorators(SetMetadata(IDEMPOTENT_META, options), UseInterceptors(IdempotencyInterceptor));
