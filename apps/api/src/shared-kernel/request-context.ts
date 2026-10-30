import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  /** Pseudonymous actor id (user UUID) once authenticated — never a phone number or e-mail. */
  actorId?: string;
  /** True only when the authenticated SESSION completed MFA (privileged roles need it). */
  mfaVerified?: boolean;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function setActor(actorId: string, opts: { mfaVerified?: boolean } = {}): void {
  const store = requestContext.getStore();
  if (store) {
    store.actorId = actorId;
    store.mfaVerified = opts.mfaVerified === true;
  }
}

export function isMfaVerified(): boolean {
  return requestContext.getStore()?.mfaVerified === true;
}
