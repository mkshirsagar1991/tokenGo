// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../problem';
import type { RawApiResponse, RawOutcome } from './api-client';
import {
  clientIp,
  handleExpired,
  handleKeepalive,
  handleLogin,
  handleLogout,
  handleMfaActivate,
  handleMfaEnroll,
  handleMfaVerify,
  handleProxy,
  safeNext,
  type BffDeps,
} from './bff';
import type { ServerConfig } from './config';
import { createRefreshCoordinator, type RefreshCallResult } from './refresh';
import { buildSessionCookie, mfaSetCookie, newSession, openSession, type SessionData } from './session';

const ORIGIN = 'http://localhost:3100';
const ID = '01a11551-74f2-7f67-8d6c-320744186e68';
const config: ServerConfig = {
  apiBaseUrl: 'http://api.test/api/v1',
  sessionSecret: 'bff-test-secret-0123456789abcdef-0123456789',
  isProduction: false,
  secureCookies: false,
  idleTimeoutMs: 15 * 60_000,
  absoluteTimeoutMs: 12 * 3_600_000,
  refreshSkewMs: 30_000,
  trustProxy: false,
  allowedOrigins: [],
  apiTimeoutMs: 5000,
};
const T0 = 2_000_000_000_000;

const raw = (status: number, body: unknown, extra: Partial<RawApiResponse> = {}): RawOutcome => ({
  ok: true,
  response: { status, contentType: status >= 400 ? 'application/problem+json; charset=utf-8' : 'application/json; charset=utf-8', text: body === undefined ? '' : JSON.stringify(body), requestId: 'api-req-1', retryAfter: null, replayed: false, ...extra },
});

function setup(over: { fetchRaw?: BffDeps['fetchRaw']; request?: (path: string, ...rest: unknown[]) => Promise<unknown>; refresh?: () => Promise<RefreshCallResult>; config?: Partial<ServerConfig> } = {}) {
  let now = T0;
  const fetchRaw = vi.fn(over.fetchRaw ?? (async () => raw(200, { data: { ok: true } })));
  const request = vi.fn(over.request ?? (async (): Promise<ApiResult<unknown>> => ({ ok: true, status: 200, data: {} })));
  const refreshCall = vi.fn(over.refresh ?? (async (): Promise<RefreshCallResult> => ({ kind: 'ok', tokens: { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 900 } })));
  const cfg = { ...config, ...over.config };
  const deps: BffDeps = { config: cfg, coordinator: createRefreshCoordinator({ call: refreshCall, now: () => now }), now: () => now, fetchRaw: fetchRaw as BffDeps['fetchRaw'], request: request as unknown as BffDeps['request'] };
  return { deps, fetchRaw, request, refreshCall, advance: (ms: number) => (now += ms), cfg };
}

const session = (over: Partial<SessionData> = {}): SessionData => ({ ...newSession({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 900 }, T0), ...over });
const cookieFor = (s: SessionData, deps: BffDeps) => {
  const c = buildSessionCookie(s, deps.now(), deps.config);
  return `${c.name}=${encodeURIComponent(c.value)}`;
};
const setCookies = (res: Response) => res.headers.getSetCookie();
const sessionFromResponse = (res: Response, deps: BffDeps): SessionData | null => {
  const header = setCookies(res).find((c) => c.startsWith('tg_session=') && !/Max-Age=0/.test(c));
  return header ? openSession(decodeURIComponent(/^tg_session=([^;]*)/.exec(header)![1]!), deps.config) : null;
};

function apiReq(method: string, path: string, opts: { cookie?: string; csrf?: string | null; origin?: string | null; marker?: boolean; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.marker !== false && method !== 'GET') headers['x-requested-with'] = 'tokengo-admin';
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${ORIGIN}/bff/api/${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const segs = (p: string) => p.split('/').map((s) => s.split('?')[0]!);

describe('proxy: authentication', () => {
  it('rejects a request with no session and never calls the API', async () => {
    const { deps, fetchRaw } = setup();
    const res = await handleProxy(apiReq('GET', 'admin/providers'), segs('admin/providers'), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('clears a cookie that cannot be opened', async () => {
    const { deps } = setup();
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie: 'tg_session=v1.garbage' }), segs('admin/providers'), deps);
    expect(res.status).toBe(401);
    expect(setCookies(res).some((c) => /^tg_session=; .*Max-Age=0/.test(c))).toBe(true);
  });

  it('signs out an idle session: 401 SESSION_IDLE, cookie cleared, and the API session revoked', async () => {
    const { deps, request, advance } = setup();
    const s = session();
    const cookie = cookieFor(s, deps);
    advance(16 * 60_000);
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie }), segs('admin/providers'), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('SESSION_IDLE');
    expect(setCookies(res).some((c) => /Max-Age=0/.test(c))).toBe(true);
    expect(request).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST', accessToken: 'AT-1' }));
  });

  it('signs out a session past its absolute lifetime even if it was just used', async () => {
    const { deps, advance } = setup();
    const s = session();
    advance(12 * 3_600_000 + 1000);
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie: cookieFor({ ...s, lastActivityAt: deps.now() }, deps) }), segs('admin/providers'), deps);
    expect((await res.json()).code).toBe('SESSION_EXPIRED');
  });
});

describe('proxy: CSRF defence on state-changing requests', () => {
  const path = `admin/providers/${ID}/approve`;

  it('rejects a missing marker header', async () => {
    const { deps, fetchRaw } = setup();
    const s = session();
    const res = await handleProxy(apiReq('POST', path, { cookie: cookieFor(s, deps), csrf: s.csrf, marker: false }), segs(path), deps);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CSRF_REJECTED');
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('rejects a foreign Origin', async () => {
    const { deps, fetchRaw } = setup();
    const s = session();
    const res = await handleProxy(apiReq('POST', path, { cookie: cookieFor(s, deps), csrf: s.csrf, origin: 'https://evil.example' }), segs(path), deps);
    expect(res.status).toBe(403);
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('rejects a request with no Origin and no Referer', async () => {
    const { deps } = setup();
    const s = session();
    const res = await handleProxy(apiReq('POST', path, { cookie: cookieFor(s, deps), csrf: s.csrf, origin: null }), segs(path), deps);
    expect(res.status).toBe(403);
  });

  it('rejects a missing or wrong synchroniser token', async () => {
    const { deps, fetchRaw } = setup();
    const s = session();
    const none = await handleProxy(apiReq('POST', path, { cookie: cookieFor(s, deps) }), segs(path), deps);
    const wrong = await handleProxy(apiReq('POST', path, { cookie: cookieFor(s, deps), csrf: 'not-the-token' }), segs(path), deps);
    expect(none.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('accepts the correct combination', async () => {
    const { deps, fetchRaw } = setup();
    const s = session();
    const res = await handleProxy(apiReq('POST', path, { cookie: cookieFor(s, deps), csrf: s.csrf }), segs(path), deps);
    expect(res.status).toBe(200);
    expect(fetchRaw).toHaveBeenCalledTimes(1);
  });

  it('does not require the token for reads (SameSite + same-site fetch metadata still apply)', async () => {
    const { deps } = setup();
    const s = session();
    const ok = await handleProxy(apiReq('GET', 'admin/providers', { cookie: cookieFor(s, deps) }), segs('admin/providers'), deps);
    expect(ok.status).toBe(200);
    const cross = await handleProxy(apiReq('GET', 'admin/providers', { cookie: cookieFor(s, deps), headers: { 'sec-fetch-site': 'cross-site' } }), segs('admin/providers'), deps);
    expect(cross.status).toBe(403);
  });
});

describe('proxy: forwarding', () => {
  it('forwards the bearer token server-side, the query string and the body, and sends an updated session cookie back', async () => {
    const { deps, fetchRaw } = setup();
    const s = session();
    const path = 'admin/payments/refunds';
    const body = { payment_transaction_id: ID, amount_minor: 5000, reason: 'duplicate charge' };
    const res = await handleProxy(apiReq('POST', `${path}?x=1`, { cookie: cookieFor(s, deps), csrf: s.csrf, body, headers: { 'idempotency-key': 'refund-1234abcd' } }), segs(path), deps);

    expect(res.status).toBe(200);
    expect(fetchRaw).toHaveBeenCalledTimes(1);
    const [calledPath, call] = fetchRaw.mock.calls[0]!;
    expect(calledPath).toBe('/admin/payments/refunds');
    expect(call).toMatchObject({ method: 'POST', accessToken: 'AT-1', body, query: { x: '1' }, headers: { 'idempotency-key': 'refund-1234abcd' } });

    // the browser gets a refreshed activity timestamp in a sealed httpOnly cookie, and never a token
    const cookieHeader = setCookies(res).find((c) => c.startsWith('tg_session='))!;
    expect(cookieHeader).toMatch(/HttpOnly/);
    expect(cookieHeader).toMatch(/SameSite=Strict/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('drops a malformed idempotency key instead of forwarding it', async () => {
    const { deps, fetchRaw } = setup();
    const s = session();
    const path = 'admin/payments/refunds';
    await handleProxy(apiReq('POST', path, { cookie: cookieFor(s, deps), csrf: s.csrf, body: {}, headers: { 'idempotency-key': 'short' } }), segs(path), deps);
    expect(fetchRaw.mock.calls[0]![1]!.headers).toEqual({});
  });

  it('refuses routes that are not on the allowlist before any session work', async () => {
    const { deps, fetchRaw } = setup();
    const s = session();
    const res = await handleProxy(apiReq('GET', 'users/me', { cookie: cookieFor(s, deps) }), segs('users/me'), deps);
    expect(res.status).toBe(404);
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('passes the API problem+json through untouched, including its request id', async () => {
    const problem = { type: 'urn:tokengo:problem:invalid_state_transition', title: 'ConflictError', status: 409, code: 'INVALID_STATE_TRANSITION', detail: 'Cannot approve a provider that is APPROVED', request_id: 'abc' };
    const { deps } = setup({ fetchRaw: async () => raw(409, problem) });
    const s = session();
    const path = `admin/providers/${ID}/approve`;
    const res = await handleProxy(apiReq('POST', path, { cookie: cookieFor(s, deps), csrf: s.csrf }), segs(path), deps);
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toEqual(problem);
    expect(res.headers.get('x-request-id')).toBe('api-req-1');
  });

  it('reports an unreachable API as 502 NETWORK_ERROR without ending the session', async () => {
    const { deps } = setup({ fetchRaw: async () => ({ ok: false, reason: 'network' }) });
    const s = session();
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie: cookieFor(s, deps) }), segs('admin/providers'), deps);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('NETWORK_ERROR');
    expect(setCookies(res).some((c) => /Max-Age=0/.test(c))).toBe(false);
  });

  it('never lets an API redirect or HTML error page reach the browser', async () => {
    const redirect = setup({ fetchRaw: async () => raw(302, undefined, { contentType: null }) });
    const html = setup({ fetchRaw: async () => ({ ok: true, response: { status: 200, contentType: 'text/html', text: '<h1>hi</h1>', requestId: null, retryAfter: null, replayed: false } }) });
    for (const { deps } of [redirect, html]) {
      const s = session();
      const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie: cookieFor(s, deps) }), segs('admin/providers'), deps);
      expect(res.status).toBe(502);
    }
  });

  it('rejects a body that is not JSON and one that is far too large', async () => {
    const { deps, fetchRaw } = setup();
    const s = session();
    const path = 'admin/payouts/run';
    const bad = new Request(`${ORIGIN}/bff/api/${path}`, { method: 'POST', headers: { cookie: cookieFor(s, deps), origin: ORIGIN, 'x-requested-with': 'tokengo-admin', 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: '{nope' });
    expect((await handleProxy(bad, segs(path), deps)).status).toBe(400);
    const huge = new Request(`${ORIGIN}/bff/api/${path}`, { method: 'POST', headers: { cookie: cookieFor(s, deps), origin: ORIGIN, 'x-requested-with': 'tokengo-admin', 'x-csrf-token': s.csrf, 'content-type': 'application/json', 'content-length': String(10_000_000) }, body: '{}' });
    expect((await handleProxy(huge, segs(path), deps)).status).toBe(413);
    expect(fetchRaw).not.toHaveBeenCalled();
  });
});

describe('proxy: transparent refresh with rotating tokens', () => {
  it('refreshes before forwarding when the access token is about to expire, and stores the NEW tokens in the cookie', async () => {
    const { deps, fetchRaw, refreshCall, advance } = setup();
    const s = session();
    const cookie = cookieFor(s, deps);
    advance(14 * 60_000 + 40_000); // 20 s of access-token life left, inside the 30 s skew; still within idle limit
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie }), segs('admin/providers'), deps);
    expect(refreshCall).toHaveBeenCalledTimes(1);
    expect(refreshCall).toHaveBeenCalledWith('RT-1');
    expect(fetchRaw.mock.calls[0]![1]!.accessToken).toBe('AT-2');
    const stored = sessionFromResponse(res, deps)!;
    expect(stored).toMatchObject({ accessToken: 'AT-2', refreshToken: 'RT-2', csrf: s.csrf, createdAt: s.createdAt });
  });

  it('shares one refresh between simultaneous requests (the old token is never presented twice)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, refreshCall, advance } = setup({
      refresh: async () => {
        await gate;
        return { kind: 'ok', tokens: { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 900 } };
      },
    });
    const s = session();
    const cookie = cookieFor(s, deps);
    advance(14 * 60_000 + 40_000);
    const all = Promise.all([1, 2, 3, 4, 5].map(() => handleProxy(apiReq('GET', 'admin/providers', { cookie }), segs('admin/providers'), deps)));
    release();
    const results = await all;
    expect(refreshCall).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.status).toBe(200);
  });

  it('ends the session (401 + cleared cookie) when the API says the refresh token is dead', async () => {
    const { deps, advance } = setup({ refresh: async () => ({ kind: 'invalid' }) });
    const s = session();
    const cookie = cookieFor(s, deps);
    advance(14 * 60_000 + 40_000);
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie }), segs('admin/providers'), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('SESSION_REVOKED');
    expect(setCookies(res).some((c) => /Max-Age=0/.test(c))).toBe(true);
  });

  it('keeps the session when a refresh could not be attempted (API unavailable) but the token is still valid', async () => {
    const { deps, advance, fetchRaw } = setup({ refresh: async () => ({ kind: 'unavailable' }) });
    const s = session();
    const cookie = cookieFor(s, deps);
    advance(14 * 60_000 + 40_000);
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie }), segs('admin/providers'), deps);
    expect(res.status).toBe(200);
    expect(fetchRaw.mock.calls[0]![1]!.accessToken).toBe('AT-1');
  });

  it('retries once with a fresh token when the API answers 401 to a token that looked valid', async () => {
    const calls: string[] = [];
    const { deps, refreshCall } = setup({
      fetchRaw: async (_p, call) => {
        calls.push(call?.accessToken ?? '');
        return call?.accessToken === 'AT-1' ? raw(401, { code: 'UNAUTHENTICATED', detail: 'expired', status: 401 }) : raw(200, { data: [] });
      },
    });
    const s = session();
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie: cookieFor(s, deps) }), segs('admin/providers'), deps);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['AT-1', 'AT-2']);
    expect(refreshCall).toHaveBeenCalledTimes(1);
    expect(sessionFromResponse(res, deps)).toMatchObject({ refreshToken: 'RT-2' });
  });

  it('signs out when the API keeps saying 401 after a refresh (revoked session)', async () => {
    const { deps } = setup({ fetchRaw: async () => raw(401, { code: 'SESSION_REVOKED', detail: 'revoked', status: 401 }) });
    const s = session();
    const res = await handleProxy(apiReq('GET', 'admin/providers', { cookie: cookieFor(s, deps) }), segs('admin/providers'), deps);
    expect(res.status).toBe(401);
    expect(setCookies(res).some((c) => /Max-Age=0/.test(c))).toBe(true);
  });
});

describe('sign-in endpoints', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/bff/auth/${path}`, { method: 'POST', headers: { origin: ORIGIN, 'x-requested-with': 'tokengo-admin', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('login: keeps the MFA token in a sealed httpOnly cookie and never returns it to the page', async () => {
    const { deps, request } = setup({ request: async () => ({ ok: true, status: 200, data: { status: 'MFA_REQUIRED', mfa_token: 'MFA-TOKEN-SECRET-VALUE-1234567890', expires_in: 300 } }) });
    const res = await handleLogin(post('login', { email: 'a@b.co', password: 'pw' }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'MFA_REQUIRED' });
    const c = setCookies(res)[0]!;
    expect(c).toMatch(/^tg_mfa=/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(decodeURIComponent(c)).not.toContain('MFA-TOKEN-SECRET');
    expect(request).toHaveBeenCalledWith('/auth/admin/login', expect.objectContaining({ body: { email: 'a@b.co', password: 'pw' } }), deps.config);
  });

  it('login: forwards the API error (generic, no hint which half was wrong) and sets no session', async () => {
    const { deps } = setup({ request: async () => ({ ok: false, status: 401, problem: { status: 401, code: 'INVALID_CREDENTIALS', detail: 'Invalid e-mail or password', requestId: 'r' } }) });
    const res = await handleLogin(post('login', { email: 'a@b.co', password: 'wrong' }), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_CREDENTIALS');
    expect(setCookies(res).every((c) => !c.startsWith('tg_session=') || /Max-Age=0/.test(c))).toBe(true);
  });

  it('login: validates input and applies the Origin check', async () => {
    const { deps, request } = setup();
    expect((await handleLogin(post('login', { email: 'a@b.co' }), deps)).status).toBe(422);
    expect((await handleLogin(post('login', { email: 'a@b.co', password: 'x'.repeat(200) }), deps)).status).toBe(422);
    expect((await handleLogin(post('login', { email: 'a@b.co', password: 'pw' }, { origin: 'https://evil.example' }), deps)).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
  });

  it('mfa verify: sets the session cookie and clears the MFA cookie; the response carries no token', async () => {
    const tokens = { access_token: 'ACCESS-JWT-SECRET', refresh_token: 'REFRESH-SECRET', token_type: 'Bearer', expires_in: 900 };
    const { deps, request } = setup({ request: async () => ({ ok: true, status: 200, data: tokens }) });
    const mfa = mfaSetCookie({ v: 1, mfaToken: 'M'.repeat(30), status: 'MFA_REQUIRED', at: T0 }, deps.config);
    const cookie = `tg_mfa=${/tg_mfa=([^;]+)/.exec(mfa)![1]}`;
    const res = await handleMfaVerify(post('mfa/verify', { code: '123456' }, { cookie }), deps);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('ACCESS-JWT-SECRET');
    expect(text).not.toContain('REFRESH-SECRET');
    const s = sessionFromResponse(res, deps)!;
    expect(s).toMatchObject({ accessToken: 'ACCESS-JWT-SECRET', refreshToken: 'REFRESH-SECRET' });
    expect(setCookies(res).some((c) => /^tg_mfa=; .*Max-Age=0/.test(c))).toBe(true);
    expect(request).toHaveBeenCalledWith('/auth/admin/mfa/verify', expect.objectContaining({ body: { mfa_token: 'M'.repeat(30), code: '123456', device_id: 'admin-portal' } }), deps.config);
  });

  it('mfa verify: needs the MFA cookie, exactly one of code/recovery code, and well-formed values', async () => {
    const { deps, request } = setup();
    const mfa = mfaSetCookie({ v: 1, mfaToken: 'M'.repeat(30), status: 'MFA_REQUIRED', at: T0 }, deps.config);
    const cookie = `tg_mfa=${/tg_mfa=([^;]+)/.exec(mfa)![1]}`;
    const noCookie = await handleMfaVerify(post('mfa/verify', { code: '123456' }), deps);
    expect(noCookie.status).toBe(401);
    expect((await noCookie.json()).code).toBe('MFA_TOKEN_INVALID');
    expect((await handleMfaVerify(post('mfa/verify', {}, { cookie }), deps)).status).toBe(422);
    expect((await handleMfaVerify(post('mfa/verify', { code: '123456', recovery_code: 'ABCDE-FGHIJ' }, { cookie }), deps)).status).toBe(422);
    expect((await handleMfaVerify(post('mfa/verify', { code: '12345' }, { cookie }), deps)).status).toBe(422);
    expect(request).not.toHaveBeenCalled();
  });

  it('mfa verify: a recovery code is accepted in its own field', async () => {
    const { deps, request } = setup({ request: async () => ({ ok: true, status: 200, data: { access_token: 'a', refresh_token: 'r', expires_in: 900 } }) });
    const mfa = mfaSetCookie({ v: 1, mfaToken: 'M'.repeat(30), status: 'MFA_REQUIRED', at: T0 }, deps.config);
    const cookie = `tg_mfa=${/tg_mfa=([^;]+)/.exec(mfa)![1]}`;
    const res = await handleMfaVerify(post('mfa/verify', { recovery_code: 'ABCDE-FGHIJ' }, { cookie }), deps);
    expect(res.status).toBe(200);
    expect(request.mock.calls[0]![1]).toMatchObject({ body: { recovery_code: 'ABCDE-FGHIJ' } });
  });

  it('enrol + activate: returns the TOTP secret for the QR, then the recovery codes once, and starts the session', async () => {
    const { deps, request } = setup({
      request: async (path: string) =>
        path.endsWith('/enroll')
          ? { ok: true, status: 200, data: { secret_base32: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/TokenGo:a@b.co?secret=JBSWY3DPEHPK3PXP' } }
          : { ok: true, status: 200, data: { access_token: 'AT', refresh_token: 'RT', expires_in: 900, recovery_codes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] } },
    });
    const mfa = mfaSetCookie({ v: 1, mfaToken: 'M'.repeat(30), status: 'MFA_ENROLLMENT_REQUIRED', at: T0 }, deps.config);
    const cookie = `tg_mfa=${/tg_mfa=([^;]+)/.exec(mfa)![1]}`;
    const enrol = await handleMfaEnroll(post('mfa/enroll', {}, { cookie }), deps);
    expect(await enrol.json()).toMatchObject({ secret_base32: 'JBSWY3DPEHPK3PXP' });
    const done = await handleMfaActivate(post('mfa/activate', { code: '123456' }, { cookie }), deps);
    const body = await done.json();
    expect(body.recovery_codes).toEqual(['AAAAA-BBBBB', 'CCCCC-DDDDD']);
    expect(JSON.stringify(body)).not.toMatch(/"AT"|"RT"/);
    expect(sessionFromResponse(done, deps)).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('a wrong code clears nothing and surfaces the API code; an expired MFA step clears the MFA cookie', async () => {
    const wrong = setup({ request: async () => ({ ok: false, status: 401, problem: { status: 401, code: 'MFA_INVALID', detail: 'Invalid verification code' } }) });
    const mfa = mfaSetCookie({ v: 1, mfaToken: 'M'.repeat(30), status: 'MFA_REQUIRED', at: T0 }, wrong.deps.config);
    const cookie = `tg_mfa=${/tg_mfa=([^;]+)/.exec(mfa)![1]}`;
    const r1 = await handleMfaVerify(post('mfa/verify', { code: '000000' }, { cookie }), wrong.deps);
    expect((await r1.json()).code).toBe('MFA_INVALID');
    expect(setCookies(r1)).toEqual([]);

    const expired = setup({ request: async () => ({ ok: false, status: 401, problem: { status: 401, code: 'MFA_TOKEN_INVALID', detail: 'Invalid MFA token' } }) });
    const r2 = await handleMfaVerify(post('mfa/verify', { code: '000000' }, { cookie }), expired.deps);
    expect(setCookies(r2).some((c) => /^tg_mfa=; .*Max-Age=0/.test(c))).toBe(true);
  });

  it('logout: revokes the API session and clears both cookies', async () => {
    const { deps, request } = setup();
    const s = session();
    const res = await handleLogout(post('logout', {}, { cookie: cookieFor(s, deps) }), deps);
    expect((await res.json()).revoked).toBe(true);
    expect(request).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ accessToken: 'AT-1' }));
    expect(setCookies(res).filter((c) => /Max-Age=0/.test(c)).length).toBe(2);
  });

  it('logout still clears the cookie when the API is down', async () => {
    const { deps } = setup({ request: async () => ({ ok: false, status: 0, problem: { status: 0, code: 'NETWORK_ERROR', detail: 'down' } }) });
    const res = await handleLogout(post('logout', {}, { cookie: cookieFor(session(), deps) }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(false);
    expect(setCookies(res).some((c) => /^tg_session=; .*Max-Age=0/.test(c))).toBe(true);
  });

  it('keepalive: counts as activity (idle timer restarts) and needs the CSRF token', async () => {
    const { deps, advance } = setup();
    const s = session();
    const cookie = cookieFor(s, deps);
    advance(10 * 60_000);
    const denied = await handleKeepalive(post('keepalive', undefined as never, { cookie }), deps);
    expect(denied.status).toBe(403);
    const ok = await handleKeepalive(post('keepalive', undefined as never, { cookie, 'x-csrf-token': s.csrf }), deps);
    expect(ok.status).toBe(200);
    expect(sessionFromResponse(ok, deps)!.lastActivityAt).toBe(deps.now());
  });
});

describe('redirect and address helpers', () => {
  it('expired: clears cookies and goes to /login with a safe next', () => {
    const { deps } = setup();
    const res = handleExpired(new Request(`${ORIGIN}/bff/auth/expired?reason=idle&next=%2Fpayouts%3Fstatus%3DPAID`), deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?reason=idle&next=%2Fpayouts%3Fstatus%3DPAID`);
    expect(res.headers.getSetCookie().filter((c) => /Max-Age=0/.test(c)).length).toBe(2);
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/bff/auth/logout', 'javascript:alert(1)', '/ok\r\nSet-Cookie: x=1'])('safeNext rejects %j', (next) => expect(safeNext(next)).toBe('/'));
  it('safeNext keeps ordinary in-site paths', () => {
    expect(safeNext('/payouts?status=PAID')).toBe('/payouts?status=PAID');
    expect(safeNext(null)).toBe('/');
  });

  it('clientIp trusts X-Forwarded-For only when told to, and takes the entry our own proxy appended', () => {
    const h = new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.9' });
    expect(clientIp(h, false)).toBeUndefined();
    expect(clientIp(h, true)).toBe('10.0.0.9');
    expect(clientIp(new Headers({ 'x-forwarded-for': 'not an ip' }), true)).toBeUndefined();
    expect(clientIp(new Headers(), true)).toBeUndefined();
  });
});
