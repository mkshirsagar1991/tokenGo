import { formatMoney } from './money';

/**
 * The API reports every failure as RFC 7807 `application/problem+json` with a stable machine `code`
 * (`status`, `code`, `detail`, optional `errors`, `request_id`). This module turns that (and transport failures) into one
 * shape the UI can render, and into messages a person can act on. UI branches on `code`/`status`, never on the message text.
 */
export interface Problem {
  status: number;
  code: string;
  detail: string;
  requestId?: string;
  /** Raw `errors` object from the API (e.g. `{ fields: { reason: ['...'] } }` or `{ refundable: {...} }`). */
  errors?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

export type ProblemKind = 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'validation' | 'rate_limited' | 'server' | 'network' | 'other';

export type ApiResult<T, M = unknown> =
  | { ok: true; status: number; data: T; meta?: M; requestId?: string }
  | { ok: false; status: number; problem: Problem };

export type ActionResult = { ok: true; message?: string } | { ok: false; problem: Problem };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function networkProblem(detail = 'Could not reach the TokenGo API. Check your connection and try again.'): Problem {
  return { status: 0, code: 'NETWORK_ERROR', detail };
}

/** Builds a Problem from a response status and its (already parsed, possibly absent) JSON body. Never throws. */
export function problemFromBody(status: number, body: unknown, headerRequestId?: string | null): Problem {
  if (isRecord(body)) {
    const code = typeof body.code === 'string' ? body.code : defaultCode(status);
    const detail = typeof body.detail === 'string' && body.detail ? body.detail : defaultDetail(status);
    return {
      status,
      code,
      detail,
      requestId: typeof body.request_id === 'string' ? body.request_id : (headerRequestId ?? undefined),
      errors: isRecord(body.errors) ? body.errors : undefined,
      retryAfterSeconds: typeof body.retry_after_seconds === 'number' ? body.retry_after_seconds : undefined,
    };
  }
  return { status, code: defaultCode(status), detail: defaultDetail(status), requestId: headerRequestId ?? undefined };
}

function defaultCode(status: number): string {
  return status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
}

function defaultDetail(status: number): string {
  if (status === 401) return 'Your session is no longer valid.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'That item was not found.';
  if (status === 409) return 'That conflicts with the current state.';
  if (status === 422 || status === 400) return 'Some of the information is not valid.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'The server had a problem. Please try again.';
  return 'The request failed.';
}

export function problemKind(p: Problem): ProblemKind {
  if (p.status === 0) return 'network';
  if (p.status === 401) return 'auth';
  if (p.status === 403) return 'forbidden';
  if (p.status === 404) return 'not_found';
  if (p.status === 409) return 'conflict';
  if (p.status === 422 || p.status === 400) return 'validation';
  if (p.status === 429) return 'rate_limited';
  if (p.status >= 500) return 'server';
  return 'other';
}

/** Specific, actionable wording for the codes the admin portal can meet. Falls back to the API's own `detail`. */
const CODE_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'The e-mail or password is not correct.',
  MFA_INVALID: 'That verification code is not valid or has already been used. Wait for the next code and try again.',
  MFA_TOKEN_INVALID: 'Your sign-in step expired. Please start again.',
  MFA_ALREADY_ENROLLED: 'Two-factor authentication is already set up for this account. Sign in with a code instead.',
  MFA_REQUIRED: 'This action needs a session that passed two-factor authentication. Sign in again.',
  SESSION_REVOKED: 'You have been signed out. Please sign in again.',
  ACCOUNT_DISABLED: 'This account is disabled. Contact a platform administrator.',
  FORBIDDEN: 'You do not have permission to do that. Ask a platform administrator if you need access.',
  CONCURRENT_MODIFICATION: 'Someone else changed this while you were looking. The page has been refreshed; review and try again.',
  INVALID_STATE_TRANSITION: 'That is no longer possible because the item changed state. The page has been refreshed.',
  REFUND_EXCEEDS_PAYMENT: 'That is more than what remains refundable on this payment.',
  PAYMENT_NOT_REFUNDABLE: 'Only a captured payment can be refunded.',
  INVALID_REASON: 'A reason of 3 to 500 characters is required.',
  RULE_VERSION_CONFLICT: 'A newer version of this rule already exists or overlaps. Reload and choose a later effective date.',
  POLICY_VERSION_CONFLICT: 'A newer version of this policy already exists or overlaps. Reload and choose a later effective date.',
  CATEGORY_CODE_TAKEN: 'That category code is already in use.',
  SERVICE_TYPE_CODE_TAKEN: 'That service type code is already in use in this category.',
  RATE_LIMITED: 'Too many attempts. Please wait a little and try again.',
  PERIOD_TOO_LONG: 'Choose a period of at most 31 days.',
  INVALID_PERIOD: 'The end of the period must be after its start.',
  NETWORK_ERROR: 'Could not reach the TokenGo API. Check your connection and try again.',
};

export function problemMessage(p: Problem): string {
  if (p.code === 'REFUND_EXCEEDS_PAYMENT') {
    const left = problemMoney(p, 'refundable');
    if (left) return `That is more than what remains refundable on this payment (${formatMoney(left)} left).`;
  }
  if (p.code === 'VALIDATION_FAILED') {
    const first = firstFieldMessage(p);
    return first ?? p.detail;
  }
  return CODE_MESSAGES[p.code] ?? p.detail;
}

/** `{ errors: { fields: { 'amount_minor': ['must not be less than 1'] } } }` -> `{ amount_minor: 'must not be less than 1' }` (first message per field). */
export function fieldErrors(p: Problem | undefined): Record<string, string> {
  const fields = p?.errors?.fields;
  const out: Record<string, string> = {};
  if (isRecord(fields)) {
    for (const [k, v] of Object.entries(fields)) {
      const msg = Array.isArray(v) ? v.find((x): x is string => typeof x === 'string') : typeof v === 'string' ? v : undefined;
      if (msg) out[k] = msg;
    }
  }
  return out;
}

function firstFieldMessage(p: Problem): string | undefined {
  const entries = Object.entries(fieldErrors(p));
  if (entries.length === 0) return undefined;
  const [field, msg] = entries[0]!;
  // The API's messages usually already start with the field name; avoid "reason: reason must be...".
  return msg.toLowerCase().startsWith(field.toLowerCase()) ? msg : `${field}: ${msg}`;
}

/** Title + explanation for a full-page error state. */
export function describeProblem(p: Problem): { title: string; message: string; kind: ProblemKind; retryable: boolean } {
  const kind = problemKind(p);
  const titles: Record<ProblemKind, string> = {
    auth: 'You have been signed out',
    forbidden: 'You do not have access',
    not_found: 'Not found',
    conflict: 'This changed while you were looking',
    validation: 'Some information is not valid',
    rate_limited: 'Slow down for a moment',
    server: 'The server had a problem',
    network: 'Cannot reach the API',
    other: 'Something went wrong',
  };
  return { title: titles[kind], message: problemMessage(p), kind, retryable: kind === 'server' || kind === 'network' || kind === 'rate_limited' || kind === 'conflict' };
}

/** Reads a typed amount from a problem's `errors` (e.g. `refundable` on REFUND_EXCEEDS_PAYMENT). */
export function problemMoney(p: Problem, key: string): { amount_minor: number; currency: string } | undefined {
  const v = p.errors?.[key];
  if (isRecord(v) && typeof v.amount_minor === 'number' && typeof v.currency === 'string') return { amount_minor: v.amount_minor, currency: v.currency };
  return undefined;
}
