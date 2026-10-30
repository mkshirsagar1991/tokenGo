import { parseCookies } from './cookies';
import { checkSession, defaultDeps, type BffDeps } from './bff';
import { sessionClearCookie, sessionCookieName } from './session';

/**
 * The authentication decision for a PAGE request, kept separate from proxy.ts so it can be unit-tested without Next.
 * Pure orchestration over `checkSession`: it returns what the proxy should do, plus the cookies to set.
 */
export type PageDecision =
  | { kind: 'next'; setCookies: string[]; /** replacement Cookie request header carrying the rotated session, when it changed */ forwardCookie?: string }
  | { kind: 'redirect'; to: string; keepNext: boolean; setCookies: string[] };

const REASON: Record<string, string | undefined> = { idle: 'idle', expired: 'expired', revoked: 'expired' };

export async function authenticateForPage(req: Request, opts: { isLogin: boolean; prefetch: boolean }, deps: BffDeps = defaultDeps()): Promise<PageDecision> {
  const r = await checkSession(req, deps, { countAsActivity: !opts.prefetch });
  const clear = (failureClears: boolean) => (failureClears ? [sessionClearCookie(deps.config)] : []);

  if (!r.ok) {
    if (opts.isLogin) return { kind: 'next', setCookies: clear(r.clearCookie) }; // the sign-in page is always reachable
    if (r.reason === 'busy') return { kind: 'next', setCookies: [] }; // API unreachable while renewing: let the page show its own error state
    const reason = REASON[r.reason];
    return { kind: 'redirect', to: reason ? `/login?reason=${reason}` : '/login', keepNext: true, setCookies: clear(r.clearCookie) };
  }

  let forwardCookie: string | undefined;
  if (r.sealed) {
    const jar = parseCookies(req.headers.get('cookie'));
    jar[r.sealed.name] = r.sealed.value;
    forwardCookie = Object.entries(jar)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ');
  }
  if (opts.isLogin) return { kind: 'redirect', to: '/', keepNext: false, setCookies: r.cookies };
  return { kind: 'next', setCookies: r.cookies, forwardCookie };
}

export { sessionCookieName };
