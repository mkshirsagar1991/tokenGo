import { describe, expect, it } from 'vitest';
import { clearCookie, parseCookies, serializeCookie } from './cookies';
import { seal, unseal } from './seal';
import {
  applyTokens,
  buildSessionCookie,
  mfaSetCookie,
  needsRefresh,
  newSession,
  openMfa,
  openSession,
  sessionCookieName,
  sessionState,
  touch,
  type SessionData,
} from './session';
import type { ServerConfig } from './config';

const SECRET = 'unit-test-secret-0123456789abcdef-0123456789';
const config = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  apiBaseUrl: 'http://api.test/api/v1',
  sessionSecret: SECRET,
  isProduction: false,
  secureCookies: false,
  idleTimeoutMs: 15 * 60_000,
  absoluteTimeoutMs: 12 * 3_600_000,
  refreshSkewMs: 30_000,
  trustProxy: false,
  allowedOrigins: [],
  apiTimeoutMs: 5000,
  ...over,
});
const tokens = { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 900 };

describe('sealed cookies (AES-256-GCM)', () => {
  it('round-trips and never contains the plaintext', () => {
    const sealed = seal({ accessToken: 'super-secret-token' }, SECRET, 'purpose');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('super-secret-token');
    expect(Buffer.from(sealed.slice(3), 'base64url').toString('utf8')).not.toContain('super-secret-token');
    expect(unseal<{ accessToken: string }>(sealed, SECRET, 'purpose')).toEqual({ accessToken: 'super-secret-token' });
  });

  it('uses a fresh IV every time', () => {
    expect(seal({ a: 1 }, SECRET, 'p')).not.toBe(seal({ a: 1 }, SECRET, 'p'));
  });

  it('refuses a tampered value, a wrong key and a different purpose (cookie swapping)', () => {
    const sealed = seal({ a: 1 }, SECRET, 'tg_session');
    const bytes = Buffer.from(sealed.slice(3), 'base64url');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(unseal(`v1.${bytes.toString('base64url')}`, SECRET, 'tg_session')).toBeNull();
    expect(unseal(sealed, 'a-completely-different-secret-value-123456', 'tg_session')).toBeNull();
    expect(unseal(sealed, SECRET, 'tg_mfa')).toBeNull();
  });

  it.each([undefined, null, '', 'garbage', 'v1.', 'v1.AAAA', 'v2.abcdefghijklmnopqrstuvwxyz'])('returns null for %j', (v) => expect(unseal(v as string, SECRET, 'p')).toBeNull());
});

describe('session lifecycle', () => {
  const t0 = 1_000_000;
  const cfg = config();

  it('is valid, then idle after the idle limit, then expired after the absolute limit', () => {
    const s = newSession(tokens, t0);
    expect(sessionState(s, t0 + 60_000, cfg)).toBe('valid');
    expect(sessionState(s, t0 + 15 * 60_000, cfg)).toBe('idle');
    // activity resets idleness but never the absolute lifetime
    const active = touch(s, t0 + 14 * 60_000);
    expect(sessionState(active, t0 + 20 * 60_000, cfg)).toBe('valid');
    expect(sessionState(touch(s, t0 + 12 * 3_600_000 - 1000), t0 + 12 * 3_600_000, cfg)).toBe('expired');
  });

  it('asks for a refresh when the access token is within the skew', () => {
    const s = newSession(tokens, t0);
    expect(needsRefresh(s, t0 + 100_000, 30_000)).toBe(false);
    expect(needsRefresh(s, t0 + 880_000, 30_000)).toBe(true);
  });

  it('keeps the creation time and CSRF secret when tokens rotate', () => {
    const s = newSession(tokens, t0);
    const next = applyTokens(s, { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 900 }, t0 + 600_000);
    expect(next).toMatchObject({ accessToken: 'AT-2', refreshToken: 'RT-2', createdAt: t0, csrf: s.csrf, lastActivityAt: t0 + 600_000 });
  });

  it('gives every session its own CSRF secret', () => {
    expect(newSession(tokens, t0).csrf).not.toBe(newSession(tokens, t0).csrf);
    expect(newSession(tokens, t0).csrf.length).toBeGreaterThanOrEqual(32);
  });
});

describe('session cookie', () => {
  const s: SessionData = newSession(tokens, 5_000);

  it('is httpOnly + SameSite=Strict, and carries no readable token', () => {
    const c = buildSessionCookie(s, 5_000, config());
    expect(c.name).toBe('tg_session');
    expect(c.header).toMatch(/HttpOnly/);
    expect(c.header).toMatch(/SameSite=Strict/);
    expect(c.header).toMatch(/Path=\//);
    expect(c.header).not.toMatch(/Secure/); // dev over http
    expect(decodeURIComponent(c.header)).not.toContain('AT-1');
    expect(decodeURIComponent(c.header)).not.toContain('RT-1');
  });

  it('is Secure and __Host- prefixed in production', () => {
    const prod = config({ isProduction: true, secureCookies: true });
    const c = buildSessionCookie(s, 5_000, prod);
    expect(c.name).toBe('__Host-tg_session');
    expect(c.header).toMatch(/; Secure/);
    expect(c.header).not.toMatch(/Domain=/);
    expect(sessionCookieName(prod)).toBe('__Host-tg_session');
  });

  it('opens what it sealed and rejects other values', () => {
    const c = buildSessionCookie(s, 5_000, config());
    const jar = parseCookies(`${c.name}=${encodeURIComponent(c.value)}`);
    expect(openSession(jar[c.name], config())).toMatchObject({ accessToken: 'AT-1', csrf: s.csrf });
    expect(openSession('nope', config())).toBeNull();
    // a sealed MFA challenge must not be accepted as a session
    const mfa = mfaSetCookie({ v: 1, mfaToken: 'x'.repeat(30), status: 'MFA_REQUIRED', at: 5_000 }, config());
    const mfaValue = decodeURIComponent(/tg_mfa=([^;]+)/.exec(mfa)![1]!);
    expect(openSession(mfaValue, config())).toBeNull();
  });

  it('limits the cookie lifetime to the remaining absolute lifetime', () => {
    const c = buildSessionCookie(s, 5_000 + 11 * 3_600_000, config());
    const maxAge = Number(/Max-Age=(\d+)/.exec(c.header)![1]);
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(maxAge).toBeGreaterThan(3500);
  });
});

describe('MFA challenge cookie', () => {
  it('expires after five minutes', () => {
    const cfg = config();
    const header = mfaSetCookie({ v: 1, mfaToken: 'm'.repeat(30), status: 'MFA_ENROLLMENT_REQUIRED', at: 1_000 }, cfg);
    const value = decodeURIComponent(/tg_mfa=([^;]+)/.exec(header)![1]!);
    expect(openMfa(value, 1_000 + 60_000, cfg)?.status).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(openMfa(value, 1_000 + 301_000, cfg)).toBeNull();
  });
});

describe('cookie helpers', () => {
  it('parses, takes the first duplicate, and survives bad encoding', () => {
    expect(parseCookies('a=1; b=two%20words; a=2; c=%E0%A4%A')).toMatchObject({ a: '1', b: 'two words' });
    expect(parseCookies(null)).toEqual({});
  });
  it('serialises with attributes and clears with Max-Age=0', () => {
    expect(serializeCookie('x', 'a b', { secure: true, maxAge: 60 })).toBe('x=a%20b; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Strict');
    expect(clearCookie('x')).toMatch(/Max-Age=0/);
  });
});
