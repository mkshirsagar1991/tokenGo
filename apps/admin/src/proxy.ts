import { NextResponse, type NextRequest } from 'next/server';
import { authenticateForPage } from '@/lib/server/page-guard';
import { buildCsp, newNonce } from '@/lib/server/csp';
import { getConfig } from '@/lib/server/config';

/**
 * Runs before every page request (not the BFF routes, which authenticate themselves and answer JSON):
 *  - sets the per-request nonce and the strict Content-Security-Policy;
 *  - enforces the session: no cookie / idle / expired / revoked -> redirect to /login;
 *  - renews the access token when it is about to expire (the only place that can both call the API and set the cookie before a
 *    server component renders), and forwards the rotated cookie to this very request's render so it never uses a rotated-away token.
 * The pages still check authorisation themselves; this is the authentication gate, not the authorisation layer.
 */
export async function proxy(req: NextRequest) {
  const config = getConfig();
  const nonce = newNonce();
  const csp = buildCsp(nonce, { dev: !config.isProduction });
  const { pathname, search } = req.nextUrl;

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  requestHeaders.set('x-tg-path', pathname + search);

  const decision = await authenticateForPage(req, { isLogin: pathname === '/login', prefetch: req.headers.has('next-router-prefetch') || req.headers.get('purpose') === 'prefetch' });

  let response: NextResponse;
  if (decision.kind === 'redirect') {
    const dest = new URL(decision.to, req.url);
    if (decision.keepNext && pathname !== '/') dest.searchParams.set('next', pathname + search);
    response = NextResponse.redirect(dest);
  } else {
    if (decision.forwardCookie) requestHeaders.set('cookie', decision.forwardCookie);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }
  for (const c of decision.setCookies) response.headers.append('set-cookie', c);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!bff|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
    },
  ],
};
