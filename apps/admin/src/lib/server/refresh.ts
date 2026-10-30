import { createHash } from 'node:crypto';
import { apiRequest } from './api-client';
import { applyTokens, type ApiTokens, type SessionData } from './session';

/**
 * Token refresh, done safely against an API that ROTATES refresh tokens (ADR-0005): presenting an already-rotated token outside a
 * short grace window revokes the whole session, so two requests must never refresh with the same token.
 *
 *  - single-flight: concurrent callers holding the same refresh token share ONE API call;
 *  - rotation memo: for a few seconds after a rotation, a late request that still carries the OLD token (the browser had not yet
 *    applied the new cookie) is given the already-obtained new tokens instead of replaying the old one at the API;
 *  - an API "invalid" answer means the session is over; "conflict"/"unavailable" never end it.
 *
 * Known limit: the coordination is per Node process. Run a single instance or sticky sessions (see README).
 */
export type RefreshCallResult = { kind: 'ok'; tokens: ApiTokens } | { kind: 'invalid' } | { kind: 'conflict' } | { kind: 'unavailable' };
export type RefreshOutcome = { kind: 'ok'; session: SessionData } | { kind: 'invalid' } | { kind: 'conflict' } | { kind: 'unavailable' };

export interface RefreshDeps {
  call: (refreshToken: string) => Promise<RefreshCallResult>;
  now: () => number;
  memoTtlMs?: number;
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export function createRefreshCoordinator(deps: RefreshDeps) {
  const memoTtl = deps.memoTtlMs ?? 20_000;
  const inflight = new Map<string, Promise<RefreshCallResult>>();
  const recent = new Map<string, { at: number; tokens: ApiTokens }>();

  const prune = () => {
    const now = deps.now();
    for (const [k, v] of recent) if (now - v.at > memoTtl) recent.delete(k);
  };

  return {
    async refresh(session: SessionData): Promise<RefreshOutcome> {
      prune();
      const key = hash(session.refreshToken);
      const memo = recent.get(key);
      let result: RefreshCallResult;
      if (memo) {
        result = { kind: 'ok', tokens: memo.tokens };
      } else {
        let pending = inflight.get(key);
        if (!pending) {
          pending = deps.call(session.refreshToken).then((r) => {
            if (r.kind === 'ok') recent.set(key, { at: deps.now(), tokens: r.tokens });
            return r;
          });
          inflight.set(key, pending);
          void pending.finally(() => inflight.delete(key)).catch(() => undefined);
        }
        result = await pending;
      }
      if (result.kind !== 'ok') return { kind: result.kind };
      return { kind: 'ok', session: applyTokens(session, result.tokens, deps.now()) };
    },
    /** Test hook. */
    _size: () => ({ inflight: inflight.size, recent: recent.size }),
  };
}

export type RefreshCoordinator = ReturnType<typeof createRefreshCoordinator>;

/** The real call: POST /auth/token/refresh. */
export async function callRefreshEndpoint(refreshToken: string): Promise<RefreshCallResult> {
  const res = await apiRequest<ApiTokens>('/auth/token/refresh', { method: 'POST', body: { refresh_token: refreshToken } });
  if (res.ok) {
    const t = res.data;
    if (t && typeof t.access_token === 'string' && typeof t.refresh_token === 'string' && typeof t.expires_in === 'number') return { kind: 'ok', tokens: t };
    return { kind: 'unavailable' };
  }
  if (res.status === 409 && res.problem.code === 'REFRESH_CONFLICT') return { kind: 'conflict' };
  if (res.status === 401 || res.status === 400 || res.status === 422) return { kind: 'invalid' };
  return { kind: 'unavailable' };
}

const KEY = Symbol.for('tokengo.admin.refresh-coordinator');
type G = typeof globalThis & { [KEY]?: RefreshCoordinator };

/** One coordinator per process, shared by the proxy, route handlers and server components (they may be separate bundles). */
export function getRefreshCoordinator(): RefreshCoordinator {
  const g = globalThis as G;
  g[KEY] ??= createRefreshCoordinator({ call: callRefreshEndpoint, now: () => Date.now() });
  return g[KEY];
}
