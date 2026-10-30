// Black-box security checks of the admin portal's backend-for-frontend, over real HTTP: headers, CSRF layers, cookie flags, sealed
// session, default-deny proxying, API-enforced permissions, and that a session cookie stops working after sign-out.
//
//   pnpm --filter @tokengo/admin check:security                      # against http://localhost:3100 (dev server or `next start`)
//   ADMIN_BASE=http://localhost:3101 pnpm --filter @tokengo/admin check:security
//
// PREREQUISITES (local development only; nothing here is for a real environment)
//   1. The API is running and the portal points at it (apps/admin/.env.local).
//   2. A FINANCE_OPERATOR test account that has already enrolled its authenticator. Create it once:
//        ADMIN_EMAIL=... ADMIN_PHONE=... ADMIN_PASSWORD=... ADMIN_ROLES=FINANCE_OPERATOR pnpm --filter @tokengo/api admin:create
//      sign in once through the portal to enrol, and put these in a git-ignored file (default: apps/api/.env.dev-finance, matched by `.env.*`):
//        ADMIN_EMAIL=..   ADMIN_PASSWORD=..   ADMIN_TOTP_SECRET=<the base32 key shown at enrolment>
//      Another file can be named with CHECK_ENV_FILE=<path>. The role matters: the checks assert that a finance operator can read
//      payouts but is refused settings by the API.
//   3. Testing a PRODUCTION build over plain http needs COOKIE_SECURE=false on the server (see .env.example); the cookie-flag
//      checks accept either the dev or the `__Host-` cookie names.
//
// No secret is printed. Exits non-zero if any check fails. A TOTP code can be used once per 30 s step, so do not run it twice within
// the same step. It signs the test account in and out, which is audited like any other session.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ADMIN_BASE || 'http://localhost:3100';
const envFile = resolve(process.env.CHECK_ENV_FILE || resolve(dirname(fileURLToPath(import.meta.url)), '../../api/.env.dev-finance'));
let env;
try {
  env = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
} catch {
  console.error(`Cannot read ${envFile}. See the PREREQUISITES at the top of this script.`);
  process.exit(2);
}
for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_TOTP_SECRET']) {
  if (!env[k]) {
    console.error(`${k} is missing from ${envFile}.`);
    process.exit(2);
  }
}

// RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits).
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const totp = () => {
  let bits = '';
  for (const c of env.ADMIN_TOTP_SECRET.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
};

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
};
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const absorb = (res) => {
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
};
const SAME = { origin: BASE, 'x-requested-with': 'tokengo-admin', 'content-type': 'application/json' };
const call = async (method, path, { headers = {}, body, withCookies = true } = {}) => {
  const res = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(withCookies && jar.size ? { cookie: cookieHeader() } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // html
  }
  return { res, status: res.status, json, text };
};

// ---- headers on a public page ----
const login = await call('GET', '/login');
const h = (n) => login.res.headers.get(n);
check('login page sends a Content-Security-Policy', !!h('content-security-policy'), (h('content-security-policy') || '').slice(0, 90));
check('CSP forbids framing (frame-ancestors) or X-Frame-Options is set', /frame-ancestors\s+'none'/.test(h('content-security-policy') || '') || /deny|sameorigin/i.test(h('x-frame-options') || ''));
check('X-Content-Type-Options: nosniff', /nosniff/i.test(h('x-content-type-options') || ''));
check('Referrer-Policy is set', !!h('referrer-policy'), h('referrer-policy') || '');
check('X-Powered-By is not advertised', !h('x-powered-by'));

// ---- unauthenticated ----
check('BFF API without a session -> 401', (await call('GET', '/bff/api/admin/payouts', { withCookies: false })).status === 401);
const page = await call('GET', '/providers', { withCookies: false });
check('a portal page without a session redirects to /login', [302, 303, 307, 308].includes(page.status) && /\/login/.test(page.res.headers.get('location') || ''), `${page.status} ${page.res.headers.get('location')}`);

// ---- CSRF layers on sign-in ----
const creds = { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD };
check('sign-in from a foreign Origin is refused (403)', (await call('POST', '/bff/auth/login', { headers: { ...SAME, origin: 'http://evil.example' }, body: creds, withCookies: false })).status === 403);
check('sign-in without the X-Requested-With marker is refused (403)', (await call('POST', '/bff/auth/login', { headers: { origin: BASE, 'content-type': 'application/json' }, body: creds, withCookies: false })).status === 403);
check('sign-in claiming Sec-Fetch-Site: cross-site is refused (403)', (await call('POST', '/bff/auth/login', { headers: { ...SAME, 'sec-fetch-site': 'cross-site' }, body: creds, withCookies: false })).status === 403);
const wrong = await call('POST', '/bff/auth/login', { headers: SAME, body: { email: creds.email, password: 'not-the-password-123' }, withCookies: false });
check('wrong password -> 401 with a generic message', wrong.status === 401 && !/no such|unknown user|not found/i.test(JSON.stringify(wrong.json)), `status ${wrong.status}`);

// ---- real sign-in (password, then TOTP) ----
const step1 = await call('POST', '/bff/auth/login', { headers: SAME, body: creds });
check('password step accepted (MFA required)', step1.status === 200, `status ${step1.status}`);
const mfaSet = step1.res.headers.getSetCookie().join('\n');
check('MFA challenge cookie is HttpOnly + SameSite=Strict', /HttpOnly/i.test(mfaSet) && /SameSite=Strict/i.test(mfaSet));
const step2 = await call('POST', '/bff/auth/mfa/verify', { headers: SAME, body: { code: totp() } });
check('authenticator code accepted -> signed in', step2.status === 200, `status ${step2.status}`);
const sessionSet = step2.res.headers.getSetCookie().find((c) => /session/i.test(c)) || '';
check('session cookie is HttpOnly', /HttpOnly/i.test(sessionSet));
check('session cookie is SameSite=Strict', /SameSite=Strict/i.test(sessionSet));
check('session cookie is scoped to Path=/', /Path=\//i.test(sessionSet));
check('session cookie value is sealed (no readable JWT inside)', !/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(decodeURIComponent([...jar.values()].join(' '))));
const sessionCookieValue = cookieHeader();

// ---- authorised use, and the limits of the finance role ----
check('finance operator can read payouts through the BFF', (await call('GET', '/bff/api/admin/payouts')).status === 200);
const settings = await call('GET', '/bff/api/admin/settings');
check('...but the API refuses settings to them (403 comes from the API, not just the menu)', settings.status === 403, `status ${settings.status}`);
check('a non-admin API path is not forwarded (default deny)', [403, 404].includes((await call('GET', '/bff/api/auth/otp/request')).status));
check('path traversal out of /admin is not forwarded', [400, 403, 404].includes((await call('GET', '/bff/api/admin/%2e%2e/auth/logout')).status));
check('a mutating call without the CSRF token is refused (403)', (await call('POST', '/bff/api/admin/payouts/run', { headers: SAME, body: {} })).status === 403);
check('a mutating call with a WRONG CSRF token is refused (403)', (await call('POST', '/bff/api/admin/payouts/run', { headers: { ...SAME, 'x-csrf-token': 'x'.repeat(32) }, body: {} })).status === 403);

// ---- sign-out must kill the session server-side, not just clear the cookie ----
const out = await call('POST', '/bff/auth/logout', { headers: SAME, body: {} });
check('logout succeeds and reports the API session revoked', out.status === 200 && out.json?.revoked === true, JSON.stringify(out.json));
const replay = await fetch(BASE + '/bff/api/admin/payouts', { headers: { cookie: sessionCookieValue } });
check('REPLAYING the old session cookie after logout is rejected (401)', replay.status === 401, `status ${replay.status}`);

console.log(results.every(Boolean) ? 'ALL BFF SECURITY CHECKS PASSED' : `FAILED: ${results.filter((r) => !r).length} of ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
