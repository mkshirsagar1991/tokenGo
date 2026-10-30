import { describe, expect, it } from 'vitest';
import { describeProblem, fieldErrors, networkProblem, problemFromBody, problemKind, problemMessage, problemMoney } from './problem';

describe('problemFromBody (RFC 7807 from the API)', () => {
  it('maps the standard fields', () => {
    const p = problemFromBody(409, { type: 'urn:x', title: 'ConflictError', status: 409, code: 'INVALID_STATE_TRANSITION', detail: 'Cannot approve a provider that is APPROVED', request_id: 'req-1' });
    expect(p).toMatchObject({ status: 409, code: 'INVALID_STATE_TRANSITION', requestId: 'req-1' });
    expect(p.detail).toContain('Cannot approve');
  });

  it('falls back to the response header for the request id', () => {
    expect(problemFromBody(500, { code: 'INTERNAL_ERROR', detail: 'Internal server error' }, 'hdr-9').requestId).toBe('hdr-9');
  });

  it('never throws on garbage and still gives something sensible', () => {
    for (const body of [undefined, null, 'oops', 42, [], {}]) {
      const p = problemFromBody(403, body);
      expect(p.status).toBe(403);
      expect(p.detail.length).toBeGreaterThan(5);
    }
    expect(problemFromBody(404, {}).code).toBe('NOT_FOUND');
    expect(problemFromBody(401, undefined).code).toBe('UNAUTHENTICATED');
  });

  it('keeps retry-after for rate limiting', () => {
    expect(problemFromBody(429, { code: 'RATE_LIMITED', detail: 'slow', retry_after_seconds: 30 }).retryAfterSeconds).toBe(30);
  });
});

describe('422 validation errors', () => {
  const p = problemFromBody(422, {
    code: 'VALIDATION_FAILED',
    detail: 'Request validation failed',
    errors: { fields: { reason: ['reason must be longer than or equal to 5 characters', 'x'], amount_minor: ['must not be less than 1'] } },
  });

  it('flattens to the first message per field', () => {
    expect(fieldErrors(p)).toEqual({ reason: 'reason must be longer than or equal to 5 characters', amount_minor: 'must not be less than 1' });
  });
  it('builds a readable sentence without repeating the field name', () => {
    expect(problemMessage(p)).toBe('reason must be longer than or equal to 5 characters');
    const q = problemFromBody(422, { code: 'VALIDATION_FAILED', detail: 'Request validation failed', errors: { fields: { scope_id: ['is required for this scope'] } } });
    expect(problemMessage(q)).toBe('scope_id: is required for this scope');
  });
  it('is empty when there are no field errors', () => {
    expect(fieldErrors(undefined)).toEqual({});
    expect(fieldErrors(problemFromBody(422, { code: 'VALIDATION_FAILED', detail: 'bad' }))).toEqual({});
  });
});

describe('kinds and messages', () => {
  it('classifies by status', () => {
    expect(problemKind(networkProblem())).toBe('network');
    expect(problemKind({ status: 401, code: 'X', detail: '' })).toBe('auth');
    expect(problemKind({ status: 403, code: 'FORBIDDEN', detail: '' })).toBe('forbidden');
    expect(problemKind({ status: 404, code: 'NOT_FOUND', detail: '' })).toBe('not_found');
    expect(problemKind({ status: 409, code: 'X', detail: '' })).toBe('conflict');
    expect(problemKind({ status: 422, code: 'X', detail: '' })).toBe('validation');
    expect(problemKind({ status: 400, code: 'X', detail: '' })).toBe('validation');
    expect(problemKind({ status: 429, code: 'X', detail: '' })).toBe('rate_limited');
    expect(problemKind({ status: 503, code: 'X', detail: '' })).toBe('server');
  });

  it('gives actionable wording for known codes and the API detail for unknown ones', () => {
    expect(problemMessage({ status: 403, code: 'FORBIDDEN', detail: 'raw' })).toMatch(/permission/i);
    expect(problemMessage({ status: 409, code: 'CONCURRENT_MODIFICATION', detail: 'raw' })).toMatch(/someone else/i);
    expect(problemMessage({ status: 422, code: 'REFUND_EXCEEDS_PAYMENT', detail: 'raw' })).toMatch(/refundable/i);
    expect(problemMessage({ status: 418, code: 'TEAPOT', detail: 'I am a teapot' })).toBe('I am a teapot');
  });

  it('describes a whole-page failure and says whether to offer a retry', () => {
    expect(describeProblem({ status: 403, code: 'FORBIDDEN', detail: '' })).toMatchObject({ kind: 'forbidden', retryable: false });
    expect(describeProblem({ status: 503, code: 'X', detail: 'down' })).toMatchObject({ kind: 'server', retryable: true });
    expect(describeProblem(networkProblem())).toMatchObject({ kind: 'network', retryable: true });
  });

  it('reads typed money out of error details', () => {
    const p = problemFromBody(422, { code: 'REFUND_EXCEEDS_PAYMENT', detail: 'x', errors: { refundable: { amount_minor: 5000, currency: 'INR' } } });
    expect(problemMoney(p, 'refundable')).toEqual({ amount_minor: 5000, currency: 'INR' });
    expect(problemMoney(p, 'missing')).toBeUndefined();
  });
});
