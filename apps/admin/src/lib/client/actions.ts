import type { ActionResult, ApiResult } from '../problem';

/** Turns a BFF result into what ConfirmDialog expects. */
export function toAction(result: ApiResult<unknown, unknown>, successMessage: string): ActionResult {
  return result.ok ? { ok: true, message: successMessage } : { ok: false, problem: result.problem };
}

/** Problems that mean "what you are looking at is stale": the page should be re-read so the UI shows the truth. */
export function isStaleProblem(code: string): boolean {
  return ['CONCURRENT_MODIFICATION', 'INVALID_STATE_TRANSITION', 'USER_NOT_ACTIVE', 'USER_NOT_SUSPENDED', 'PAYMENT_NOT_REFUNDABLE'].includes(code);
}

/** A fresh idempotency key for one user intent (e.g. one opening of the refund dialog). */
export function newIdempotencyKey(prefix = 'adm'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}
