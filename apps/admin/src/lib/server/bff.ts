import type { Problem } from '../problem';
import { checkAllowed } from './allowlist';
import { apiFetchRaw, apiRequest } from './api-client';
import { getConfig, type ServerConfig } from './config';
import { parseCookies } from './cookies';
import { CSRF_HEADER, checkRequestOrigin, hasRequestedWithHeader, isStateChanging, safeEqual } from './csrf';
import { getRefreshCoordinator, type RefreshCoordinator } from './refresh';
import {
  mfaClearCookie,
  mfaCookieName,
  mfaSetCookie,
  buildSessionCookie,
  newSession,
  openMfa,
  openSession,
  sessionClearCookie,
  sessionCookieName,
  sessionSetCookie,
  sessionState,
  needsRefresh,
  touch,
  type ApiTokens,
  type SessionData,
} from './session';

/**
 * The backend-for-frontend core. Route handlers under src/app/bff are thin wrappers around these functions, which use only the
 * Web `Request`/`Response` types so they can be unit-tested without Next.
 */
export interface BffDeps {
  config: ServerConfig;
  coordinator: RefreshCoordinator;
  now: () => number;
  fetchRaw: typeof apiFetchRaw;
  request: typeof apiRequest;
}

export function defaultDeps(): BffDeps {
  return { config: getConfig(), coordinator: getRefreshCoordinator(), now: () => Date.now(), fetchRaw: apiFetchRaw, request: apiRequest };
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_BODY_BYTES = 256 * 1024;
const DEVICE_ID = 'admin-portal';

// ---- response helpers -----------------------------------------------------------------------------------------------------
export function jsonResponse(body: unknown, status = 200, cookies: string[] = [], extra: Record<string, string> = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

export function problemResponse(p: Problem, cookies: string[] = []): Response {
  const status = p.status >= 400 && p.status < 600 ? p.status : 502;
  return jsonResponse({ status, code: p.code, detail: p.detail, request_id: p.requestId, errors: p.errors, retry_after_seconds: p.retryAfterSeconds }, status, cookies, p.retryAfterSeconds ? { 'retry-after': String(p.retryAfterSeconds) } : {});
}

const simpleProblem = (status: number, code: string, detail: string, cookies: string[] = []) => problemResponse({ status, code, detail }, cookies);

// ---- request helpers ------------------------------------------------------------------------------------------------------
export function clientIp(headers: Pick<Headers, 'get'>, trustProxy: boolean): string | undefined {
  if (!trustProxy) return undefined;
  const parts = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1]; // rightmost entry = the one our own proxy appended (matches the API's `trust proxy = 1`)
  return last && /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last : undefined;
}

/** Only same-site relative paths may be used as a post-login destination (no open redirect). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\r\n]/.test(next) || next.startsWith('/bff')) return '/';
  return next.slice(0, 500);
}

/** Origin + custom-header defence. `null` means the request is acceptable. */
export function guardRequest(req: Request, deps: BffDeps): Response | null {
  const mutating = isStateChanging(req.method);
  const ok = checkRequestOrigin({
    origin: req.headers.get('origin'),
    referer: req.headers.get('referer'),
    secFetchSite: req.headers.get('sec-fetch-site'),
    selfOrigin: new URL(req.url).origin,
    allowedOrigins: deps.config.allowedOrigins,
  });
  // GETs from a browser navigation carry no Origin; for them only an explicit cross-site Sec-Fetch-Site is refused.
  const getOk = !req.headers.get('sec-fetch-site') || ['same-origin', 'none'].includes(req.headers.get('sec-fetch-site')!);
  if (mutating ? !ok : !getOk) return simpleProblem(403, 'CSRF_REJECTED', 'The request did not come from this site.');
  if (mutating && !hasRequestedWithHeader(req.headers)) return simpleProblem(403, 'CSRF_REJECTED', 'The request is missing a required header.');
  return null;
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return { ok: false, response: simpleProblem(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.') };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: simpleProblem(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.') };
  if (text === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: simpleProblem(400, 'INVALID_JSON', 'The request body is not valid JSON.') };
  }
}

// ---- session handling -----------------------------------------------------------------------------------------------------
export function readSession(req: Request, deps: BffDeps): { session: SessionData | null; present: boolean } {
  const raw = parseCookies(req.headers.get('cookie'))[sessionCookieName(deps.config)];
  return { session: openSession(raw, deps.config), present: Boolean(raw) };
}

/** Best effort: revoke the API session so a signed-out/idle browser cannot be revived. Never throws. */
export async function revokeSession(session: SessionData, deps: BffDeps): Promise<boolean> {
  try {
    const first = await deps.request('/auth/logout', { method: 'POST', accessToken: session.accessToken });
    if (first.ok) return true;
    if (first.status !== 401) return false;
    const r = await deps.coordinator.refresh(session);
    if (r.kind !== 'ok') return false;
    return (await deps.request('/auth/logout', { method: 'POST', accessToken: r.session.accessToken })).ok;
  } catch {
    return false;
  }
}

export type SessionFailure = 'none' | 'invalid' | 'idle' | 'expired' | 'revoked' | 'busy';
export type SessionCheck =
  | { ok: true; session: SessionData; cookies: string[]; /** the new sealed cookie (name/value) when the session changed, so a caller can forward it to the same request's render */ sealed?: { name: string; value: string }; refreshed: boolean }
  | { ok: false; reason: SessionFailure; clearCookie: boolean };

/**
 * Validates the session cookie (present, unsealable, within idle/absolute limits), refreshes the access token when it is about to
 * expire, and returns the session with an updated activity time plus the Set-Cookie to send back.
 */
export async function checkSession(req: Request, deps: BffDeps, opts: { countAsActivity?: boolean } = {}): Promise<SessionCheck> {
  const { session, present } = readSession(req, deps);
  if (!session) return { ok: false, reason: present ? 'invalid' : 'none', clearCookie: present };

  const now = deps.now();
  const state = sessionState(session, now, deps.config);
  if (state !== 'valid') {
    void revokeSession(session, deps); // an idle/expired browser must not leave a live server-side session behind
    return { ok: false, reason: state === 'idle' ? 'idle' : 'expired', clearCookie: true };
  }

  let current = session;
  let refreshed = false;
  if (needsRefresh(current, now, deps.config.refreshSkewMs)) {
    const r = await deps.coordinator.refresh(current);
    if (r.kind === 'ok') {
      current = r.session;
      refreshed = true;
    } else if (r.kind === 'invalid') {
      return { ok: false, reason: 'revoked', clearCookie: true };
    } else if (current.accessExpiresAt <= now) {
      return { ok: false, reason: 'busy', clearCookie: false }; // the API could not renew a token that is already dead
    }
  }
  const countsAsActivity = opts.countAsActivity !== false;
  if (!countsAsActivity && !refreshed) return { ok: true, session: current, cookies: [], refreshed };
  const final = countsAsActivity ? touch(current, now) : current;
  const built = buildSessionCookie(final, now, deps.config);
  return { ok: true, session: final, cookies: [built.header], sealed: { name: built.name, value: built.value }, refreshed };
}

export type Authenticated = { ok: true; session: SessionData; cookies: string[]; refreshed: boolean } | { ok: false; response: Response };

const FAILURE_RESPONSES: Record<SessionFailure, { status: number; code: string; detail: string }> = {
  none: { status: 401, code: 'UNAUTHENTICATED', detail: 'Please sign in.' },
  invalid: { status: 401, code: 'UNAUTHENTICATED', detail: 'Your session is not valid. Please sign in again.' },
  idle: { status: 401, code: 'SESSION_IDLE', detail: 'You were signed out after a period of inactivity.' },
  expired: { status: 401, code: 'SESSION_EXPIRED', detail: 'Your session reached its maximum age. Please sign in again.' },
  revoked: { status: 401, code: 'SESSION_REVOKED', detail: 'You have been signed out. Please sign in again.' },
  busy: { status: 503, code: 'SESSION_REFRESH_BUSY', detail: 'Your session is being renewed. Please try again in a moment.' },
};

/** `checkSession`, with failures rendered as JSON problem responses (for route handlers). */
export async function authenticate(req: Request, deps: BffDeps, opts: { countAsActivity?: boolean } = {}): Promise<Authenticated> {
  const r = await checkSession(req, deps, opts);
  if (r.ok) return r;
  const f = FAILURE_RESPONSES[r.reason];
  return { ok: false, response: simpleProblem(f.status, f.code, f.detail, r.clearCookie ? [sessionClearCookie(deps.config)] : []) };
}

// ---- the generic, allowlisted admin proxy ---------------------------------------------------------------------------------
export async function handleProxy(req: Request, segments: string[], deps: BffDeps = defaultDeps()): Promise<Response> {
  const method = req.method.toUpperCase();
  const decision = checkAllowed(method, segments);
  if (!decision.allowed) {
    return decision.reason === 'method' ? simpleProblem(405, 'METHOD_NOT_ALLOWED', 'That method is not supported.') : simpleProblem(404, 'NOT_FOUND', 'That route is not available through the portal.');
  }
  const blocked = guardRequest(req, deps);
  if (blocked) return blocked;

  const auth = await authenticate(req, deps);
  if (!auth.ok) return auth.response;
  let { session, cookies } = auth;

  const mutating = isStateChanging(method);
  if (mutating && !safeEqual(req.headers.get(CSRF_HEADER), session.csrf)) return simpleProblem(403, 'CSRF_REJECTED', 'Your page is out of date. Reload and try again.', cookies);

  let body: unknown;
  if (mutating) {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    body = parsed.value;
  }
  const headers: Record<string, string> = {};
  const idem = req.headers.get('idempotency-key');
  if (idem && IDEMPOTENCY_KEY.test(idem)) headers['idempotency-key'] = idem;

  const query: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => {
    query[k] = v;
  });
  const ip = clientIp(req.headers, deps.config.trustProxy);

  const send = (token: string) => deps.fetchRaw(`/${decision.path}`, { method: method as 'GET', query, body, headers, accessToken: token, clientIp: ip, timeoutMs: 30_000 }, deps.config);
  let out = await send(session.accessToken);

  // The access token can expire between our check and the API's: renew once and retry. (The API treats a revoked session as 401 too;
  // in that case the refresh fails as "invalid" and the user is signed out.)
  if (out.ok && out.response.status === 401 && !auth.refreshed) {
    const r = await deps.coordinator.refresh(session);
    if (r.kind === 'ok') {
      session = touch(r.session, deps.now());
      cookies = [sessionSetCookie(session, deps.now(), deps.config)];
      out = await send(session.accessToken);
    } else if (r.kind === 'invalid') {
      return simpleProblem(401, 'SESSION_REVOKED', 'You have been signed out. Please sign in again.', [sessionClearCookie(deps.config)]);
    }
  }

  if (!out.ok) return simpleProblem(502, 'NETWORK_ERROR', out.reason === 'timeout' ? 'The TokenGo API took too long to answer.' : 'Could not reach the TokenGo API.', cookies);
  const { response } = out;
  if (response.status === 401) return simpleProblem(401, 'SESSION_REVOKED', 'You have been signed out. Please sign in again.', [sessionClearCookie(deps.config)]);

  const type = (response.contentType ?? '').toLowerCase();
  const isJson = type.startsWith('application/json') || type.startsWith('application/problem+json');
  if (response.status >= 300 && response.status < 400) return simpleProblem(502, 'BAD_GATEWAY', 'Unexpected response from the API.', cookies);
  if (response.status === 204) return jsonResponse(undefined, 204, cookies);
  if (!isJson) return simpleProblem(response.status >= 400 ? response.status : 502, 'BAD_GATEWAY', 'Unexpected response from the API.', cookies);

  const extra: Record<string, string> = {};
  if (response.requestId) extra['x-request-id'] = response.requestId;
  if (response.retryAfter) extra['retry-after'] = response.retryAfter;
  if (response.replayed) extra['idempotent-replayed'] = 'true';
  const res = new Response(response.text, { status: response.status, headers: { 'content-type': type.startsWith('application/problem+json') ? 'application/problem+json' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
  for (const c of cookies) res.headers.append('set-cookie', c);
  return res;
}

// ---- authentication endpoints ---------------------------------------------------------------------------------------------
const isStr = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const asObj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function handleLogin(req: Request, deps: BffDeps = defaultDeps()): Promise<Response> {
  const blocked = guardRequest(req, deps);
  if (blocked) return blocked;
  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.response;
  const { email, password } = asObj(parsed.value);
  if (!isStr(email, 3, 320) || !isStr(password, 1, 128)) return simpleProblem(422, 'VALIDATION_FAILED', 'Enter your e-mail and password.');

  const res = await deps.request<{ status: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED'; mfa_token: string }>('/auth/admin/login', { method: 'POST', body: { email, password }, clientIp: clientIp(req.headers, deps.config.trustProxy) }, deps.config);
  if (!res.ok) return problemResponse(res.problem, [mfaClearCookie(deps.config)]);
  const { status, mfa_token } = res.data;
  if (typeof mfa_token !== 'string' || (status !== 'MFA_REQUIRED' && status !== 'MFA_ENROLLMENT_REQUIRED')) return simpleProblem(502, 'BAD_GATEWAY', 'Unexpected response from the API.');
  return jsonResponse({ status }, 200, [mfaSetCookie({ v: 1, mfaToken: mfa_token, status, at: deps.now() }, deps.config)]);
}

function readMfa(req: Request, deps: BffDeps) {
  return openMfa(parseCookies(req.headers.get('cookie'))[mfaCookieName(deps.config)], deps.now(), deps.config);
}

const expiredStep = (deps: BffDeps) => simpleProblem(401, 'MFA_TOKEN_INVALID', 'Your sign-in step expired. Please start again.', [mfaClearCookie(deps.config)]);

export async function handleMfaEnroll(req: Request, deps: BffDeps = defaultDeps()): Promise<Response> {
  const blocked = guardRequest(req, deps);
  if (blocked) return blocked;
  const ch = readMfa(req, deps);
  if (!ch) return expiredStep(deps);
  const res = await deps.request<{ secret_base32: string; otpauth_uri: string }>('/auth/admin/mfa/enroll', { method: 'POST', body: { mfa_token: ch.mfaToken } }, deps.config);
  if (!res.ok) return problemResponse(res.problem, res.problem.code === 'MFA_TOKEN_INVALID' ? [mfaClearCookie(deps.config)] : []);
  return jsonResponse({ secret_base32: res.data.secret_base32, otpauth_uri: res.data.otpauth_uri });
}

async function completeSignIn(res: Awaited<ReturnType<typeof apiRequest<ApiTokens & { recovery_codes?: string[] }>>>, deps: BffDeps): Promise<Response> {
  if (!res.ok) return problemResponse(res.problem, res.problem.code === 'MFA_TOKEN_INVALID' ? [mfaClearCookie(deps.config)] : []);
  const t = res.data;
  if (!t || typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string' || typeof t.expires_in !== 'number') return simpleProblem(502, 'BAD_GATEWAY', 'Unexpected response from the API.');
  const now = deps.now();
  const session = newSession(t, now);
  return jsonResponse({ ok: true, recovery_codes: Array.isArray(t.recovery_codes) ? t.recovery_codes : undefined }, 200, [sessionSetCookie(session, now, deps.config), mfaClearCookie(deps.config)]);
}

export async function handleMfaActivate(req: Request, deps: BffDeps = defaultDeps()): Promise<Response> {
  const blocked = guardRequest(req, deps);
  if (blocked) return blocked;
  const ch = readMfa(req, deps);
  if (!ch) return expiredStep(deps);
  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.response;
  const { code } = asObj(parsed.value);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return simpleProblem(422, 'VALIDATION_FAILED', 'Enter the 6-digit code from your authenticator app.');
  const res = await deps.request<ApiTokens & { recovery_codes: string[] }>('/auth/admin/mfa/activate', { method: 'POST', body: { mfa_token: ch.mfaToken, code, device_id: DEVICE_ID }, clientIp: clientIp(req.headers, deps.config.trustProxy) }, deps.config);
  return completeSignIn(res, deps);
}

export async function handleMfaVerify(req: Request, deps: BffDeps = defaultDeps()): Promise<Response> {
  const blocked = guardRequest(req, deps);
  if (blocked) return blocked;
  const ch = readMfa(req, deps);
  if (!ch) return expiredStep(deps);
  const parsed = await readJson(req);
  if (!parsed.ok) return parsed.response;
  const { code, recovery_code } = asObj(parsed.value);
  const hasCode = typeof code === 'string' && /^\d{6}$/.test(code);
  const hasRecovery = typeof recovery_code === 'string' && /^[A-Za-z0-9-]{10,12}$/.test(recovery_code);
  if (hasCode === hasRecovery) return simpleProblem(422, 'VALIDATION_FAILED', 'Enter the 6-digit code from your authenticator app, or one recovery code.');
  const res = await deps.request<ApiTokens>('/auth/admin/mfa/verify', { method: 'POST', body: { mfa_token: ch.mfaToken, ...(hasCode ? { code } : { recovery_code }), device_id: DEVICE_ID }, clientIp: clientIp(req.headers, deps.config.trustProxy) }, deps.config);
  return completeSignIn(res, deps);
}

export async function handleLogout(req: Request, deps: BffDeps = defaultDeps()): Promise<Response> {
  const blocked = guardRequest(req, deps);
  if (blocked) return blocked;
  const { session } = readSession(req, deps);
  const revoked = session ? await revokeSession(session, deps) : false;
  return jsonResponse({ ok: true, revoked }, 200, [sessionClearCookie(deps.config), mfaClearCookie(deps.config)]);
}

/** Called by the page's idle guard while the user is active: counts as activity and renews the access token if due. */
export async function handleKeepalive(req: Request, deps: BffDeps = defaultDeps()): Promise<Response> {
  const blocked = guardRequest(req, deps);
  if (blocked) return blocked;
  const auth = await authenticate(req, deps);
  if (!auth.ok) return auth.response;
  if (!safeEqual(req.headers.get(CSRF_HEADER), auth.session.csrf)) return simpleProblem(403, 'CSRF_REJECTED', 'Your page is out of date. Reload and try again.', auth.cookies);
  return jsonResponse({ ok: true, idle_timeout_ms: deps.config.idleTimeoutMs }, 200, auth.cookies);
}

/** Server components cannot clear cookies, so they redirect here when the API says the session is gone. */
export function handleExpired(req: Request, deps: BffDeps = defaultDeps()): Response {
  const url = new URL(req.url);
  const reason = ['idle', 'expired'].includes(url.searchParams.get('reason') ?? '') ? url.searchParams.get('reason') : 'expired';
  const dest = new URL('/login', url.origin);
  dest.searchParams.set('reason', reason!);
  const next = safeNext(url.searchParams.get('next'));
  if (next !== '/') dest.searchParams.set('next', next);
  const headers = new Headers({ location: dest.toString(), 'cache-control': 'no-store' });
  headers.append('set-cookie', sessionClearCookie(deps.config));
  headers.append('set-cookie', mfaClearCookie(deps.config));
  return new Response(null, { status: 303, headers });
}
