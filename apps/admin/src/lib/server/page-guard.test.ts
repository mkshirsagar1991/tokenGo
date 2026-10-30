// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { BffDeps } from './bff';
import type { ServerConfig } from './config';
import { authenticateForPage } from './page-guard';
import { createRefreshCoordinator, type RefreshCallResult } from './refresh';
import { buildSessionCookie, newSession, openSession } from './session';

const config: ServerConfig = {
  apiBaseUrl: 'http://api.test/api/v1',
  sessionSecret: 'guard-test-secret-0123456789abcdef-0123456789',
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

function setup(refresh: () => Promise<RefreshCallResult> = async () => ({ kind: 'ok', tokens: { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 900 } })) {
  let now = T0;
  const call = vi.fn(refresh);
  const deps = { config, now: () => now, coordinator: createRefreshCoordinator({ call, now: () => now }), fetchRaw: vi.fn(), request: vi.fn(async () => ({ ok: true as const, status: 200, data: {} })) } as unknown as BffDeps;
  return { deps, call, advance: (ms: number) => (now += ms) };
}
const page = (cookie?: string) => new Request('http://localhost:3100/providers', { headers: cookie ? { cookie } : {} });
const cookieOf = (deps: BffDeps) => {
  const c = buildSessionCookie(newSession({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 900 }, T0), T0, deps.config);
  return `${c.name}=${encodeURIComponent(c.value)}`;
};

describe('page authentication gate (proxy.ts)', () => {
  it('sends an anonymous visitor to the sign-in page, remembering where they were going', async () => {
    const { deps } = setup();
    expect(await authenticateForPage(page(), { isLogin: false, prefetch: false }, deps)).toEqual({ kind: 'redirect', to: '/login', keepNext: true, setCookies: [] });
  });

  it('lets the sign-in page itself through for an anonymous visitor', async () => {
    const { deps } = setup();
    expect(await authenticateForPage(page(), { isLogin: true, prefetch: false }, deps)).toMatchObject({ kind: 'next' });
  });

  it('lets a signed-in user through, refreshing the cookie, and forwards the new cookie to this very render', async () => {
    const { deps, advance } = setup();
    const cookie = cookieOf(deps);
    advance(60_000);
    const d = await authenticateForPage(page(cookie), { isLogin: false, prefetch: false }, deps);
    expect(d.kind).toBe('next');
    if (d.kind !== 'next') return;
    expect(d.setCookies[0]).toMatch(/^tg_session=/);
    const forwarded = decodeURIComponent(/tg_session=([^;]+)/.exec(d.forwardCookie!)![1]!);
    expect(openSession(forwarded, config)?.lastActivityAt).toBe(T0 + 60_000);
  });

  it('renews an access token that is about to expire BEFORE the page renders (server components cannot set cookies)', async () => {
    const { deps, call, advance } = setup();
    const cookie = cookieOf(deps);
    advance(14 * 60_000 + 40_000);
    const d = await authenticateForPage(page(cookie), { isLogin: false, prefetch: false }, deps);
    expect(call).toHaveBeenCalledWith('RT-1');
    if (d.kind !== 'next') throw new Error('expected next');
    const forwarded = openSession(decodeURIComponent(/tg_session=([^;]+)/.exec(d.forwardCookie!)![1]!), config)!;
    expect(forwarded).toMatchObject({ accessToken: 'AT-2', refreshToken: 'RT-2' });
  });

  it('does not count a link prefetch as activity (so background prefetching cannot defeat the idle timeout)', async () => {
    const { deps, advance } = setup();
    const cookie = cookieOf(deps);
    advance(60_000);
    const d = await authenticateForPage(page(cookie), { isLogin: false, prefetch: true }, deps);
    expect(d).toEqual({ kind: 'next', setCookies: [], forwardCookie: undefined });
  });

  it('redirects an idle session to sign-in with the idle notice and clears the cookie', async () => {
    const { deps, advance } = setup();
    const cookie = cookieOf(deps);
    advance(16 * 60_000);
    const d = await authenticateForPage(page(cookie), { isLogin: false, prefetch: false }, deps);
    expect(d).toMatchObject({ kind: 'redirect', to: '/login?reason=idle', keepNext: true });
    expect(d.setCookies[0]).toMatch(/Max-Age=0/);
  });

  it('redirects to sign-in when the refresh token is rejected', async () => {
    const { deps, advance } = setup(async () => ({ kind: 'invalid' }));
    const cookie = cookieOf(deps);
    advance(14 * 60_000 + 40_000);
    expect(await authenticateForPage(page(cookie), { isLogin: false, prefetch: false }, deps)).toMatchObject({ kind: 'redirect', to: '/login?reason=expired' });
  });

  it('bounces an already signed-in user away from /login', async () => {
    const { deps } = setup();
    expect(await authenticateForPage(page(cookieOf(deps)), { isLogin: true, prefetch: false }, deps)).toMatchObject({ kind: 'redirect', to: '/', keepNext: false });
  });

  it('lets the page render its own error state when the API is unreachable while renewing', async () => {
    const { deps, advance } = setup(async () => ({ kind: 'unavailable' }));
    const cookie = cookieOf(deps);
    advance(14 * 60_000 + 59_000);
    // token is still valid for 1 s, so the session is kept
    expect(await authenticateForPage(page(cookie), { isLogin: false, prefetch: false }, deps)).toMatchObject({ kind: 'next' });
  });
});
