/**
 * Strict Content-Security-Policy, built per request with a fresh nonce (set by src/proxy.ts).
 * No inline scripts or styles are allowed except the framework's own (which Next tags with the nonce).
 * Dev needs `unsafe-eval` (React's debugging) and inline styles (the error overlay / HMR); production does not.
 */
export function buildCsp(nonce: string, opts: { dev: boolean }): string {
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' ${opts.dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'${opts.dev ? ' ws: wss:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(opts.dev ? [] : ['upgrade-insecure-requests']),
  ];
  return directives.join('; ');
}

export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}
