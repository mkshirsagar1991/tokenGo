import type { NextConfig } from 'next';

/**
 * Static security headers. The Content-Security-Policy is NOT here: it needs a per-request nonce, so it is set by
 * src/proxy.ts (see src/lib/server/csp.ts). Everything an authenticated user sees is `no-store`.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/((?!_next/static|_next/image|favicon.ico).*)', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
};

export default config;
