import { problemFromBody, networkProblem, type ApiResult } from '../problem';

/**
 * Browser-side client for the BFF. It talks ONLY to this site (`/bff/...`): the session cookie is httpOnly (never readable here), and
 * every state-changing call carries the per-session CSRF token plus the marker header the BFF requires.
 */
export interface BffCallOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const SESSION_CODES = new Set(['UNAUTHENTICATED', 'SESSION_REVOKED', 'SESSION_IDLE', 'SESSION_EXPIRED']);

export interface BffClient {
  get<T = unknown, M = unknown>(path: string, query?: Record<string, string | undefined>, opts?: BffCallOptions): Promise<ApiResult<T, M>>;
  post<T = unknown>(path: string, body?: unknown, opts?: BffCallOptions): Promise<ApiResult<T>>;
  put<T = unknown>(path: string, body?: unknown, opts?: BffCallOptions): Promise<ApiResult<T>>;
  patch<T = unknown>(path: string, body?: unknown, opts?: BffCallOptions): Promise<ApiResult<T>>;
}

function leaveToSignIn(code: string) {
  if (typeof window === 'undefined') return;
  const reason = code === 'SESSION_IDLE' ? 'idle' : 'expired';
  const next = window.location.pathname + window.location.search;
  // A full navigation to a route handler that clears the dead cookie (a client-side push cannot).
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/bff/auth/expired?reason=${reason}&next=${encodeURIComponent(next)}`);
}

export function createBffClient(csrf: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): BffClient {
  async function call<T, M = unknown>(method: string, path: string, query: Record<string, string | undefined> | undefined, body: unknown, opts: BffCallOptions = {}): Promise<ApiResult<T, M>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v) qs.set(k, v);
    const url = `/bff/api/${path.replace(/^\/+/, '')}${qs.size ? `?${qs}` : ''}`;
    const headers: Record<string, string> = { accept: 'application/json', 'x-requested-with': 'tokengo-admin', 'x-csrf-token': csrf };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    let res: Response;
    try {
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', signal: opts.signal });
    } catch {
      return { ok: false, status: 0, problem: networkProblem() };
    }
    let parsed: unknown;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (res.ok) {
      const env = parsed as { data?: T; meta?: M } | undefined;
      const hasEnvelope = env !== null && typeof env === 'object' && 'data' in env;
      return { ok: true, status: res.status, data: (hasEnvelope ? env.data : parsed) as T, meta: hasEnvelope ? env.meta : undefined, requestId: res.headers.get('x-request-id') ?? undefined };
    }
    const problem = problemFromBody(res.status, parsed, res.headers.get('x-request-id'));
    if (res.status === 401 && SESSION_CODES.has(problem.code)) leaveToSignIn(problem.code);
    return { ok: false, status: res.status, problem };
  }

  return {
    get: (path, query, opts) => call('GET', path, query, undefined, opts),
    post: (path, body, opts) => call('POST', path, undefined, body, opts),
    put: (path, body, opts) => call('PUT', path, undefined, body, opts),
    patch: (path, body, opts) => call('PATCH', path, undefined, body, opts),
  };
}

/** Tells the server the person is still active (resets the idle timer, renews the access token if due). */
export async function sendKeepalive(csrf: string): Promise<boolean> {
  try {
    const res = await fetch('/bff/auth/keepalive', { method: 'POST', headers: { 'x-requested-with': 'tokengo-admin', 'x-csrf-token': csrf }, credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) leaveToSignIn('SESSION_IDLE');
    return res.ok;
  } catch {
    return false;
  }
}

/** Calls an unauthenticated BFF auth endpoint (login / MFA). A 401 here is a bad credential, not an expired session, so there is no redirect. */
export async function authCall<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/bff/auth/${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-requested-with': 'tokengo-admin' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, problem: networkProblem() };
  }
  const text = await res.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (res.ok) return { ok: true, status: res.status, data: parsed as T };
  return { ok: false, status: res.status, problem: problemFromBody(res.status, parsed, res.headers.get('x-request-id')) };
}
