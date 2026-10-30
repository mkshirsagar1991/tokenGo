import { randomBytes } from 'node:crypto';
import { clearCookie, serializeCookie, type CookieOptions } from './cookies';
import type { ServerConfig } from './config';
import { seal, unseal } from './seal';

/**
 * The browser never sees an API token. The session is ONE sealed (AES-GCM) httpOnly cookie holding the access token, the rotating
 * refresh token, a per-session CSRF secret and the timestamps that drive idle / absolute expiry. Because it is sealed, the
 * timestamps cannot be forged client-side.
 */
export interface ApiTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface SessionData {
  v: 1;
  accessToken: string;
  refreshToken: string;
  /** ms epoch when the access token expires. */
  accessExpiresAt: number;
  createdAt: number;
  lastActivityAt: number;
  /** Synchroniser token the UI echoes in `X-CSRF-Token` on every state-changing request. */
  csrf: string;
}

export interface MfaChallenge {
  v: 1;
  mfaToken: string;
  status: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  at: number;
}

export const SESSION_COOKIE_DEV = 'tg_session';
export const MFA_COOKIE_DEV = 'tg_mfa';
export const MFA_TTL_SECONDS = 300;

export const sessionCookieName = (c: Pick<ServerConfig, 'secureCookies'>) => (c.secureCookies ? '__Host-tg_session' : SESSION_COOKIE_DEV);
export const mfaCookieName = (c: Pick<ServerConfig, 'secureCookies'>) => (c.secureCookies ? '__Host-tg_mfa' : MFA_COOKIE_DEV);

const baseCookie = (c: Pick<ServerConfig, 'secureCookies'>): CookieOptions => ({ httpOnly: true, secure: c.secureCookies, sameSite: 'strict', path: '/' });

export function newSession(tokens: ApiTokens, now: number, csrf: string = randomBytes(24).toString('base64url')): SessionData {
  return { v: 1, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessExpiresAt: now + tokens.expires_in * 1000, createdAt: now, lastActivityAt: now, csrf };
}

/** Same session, new tokens (after a refresh). Keeps the creation time (absolute lifetime) and the CSRF secret. */
export function applyTokens(s: SessionData, tokens: ApiTokens, now: number): SessionData {
  return { ...s, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessExpiresAt: now + tokens.expires_in * 1000, lastActivityAt: now };
}

export const touch = (s: SessionData, now: number): SessionData => ({ ...s, lastActivityAt: now });

export type SessionState = 'valid' | 'idle' | 'expired';

export function sessionState(s: SessionData, now: number, c: Pick<ServerConfig, 'idleTimeoutMs' | 'absoluteTimeoutMs'>): SessionState {
  if (now - s.createdAt >= c.absoluteTimeoutMs) return 'expired';
  if (now - s.lastActivityAt >= c.idleTimeoutMs) return 'idle';
  return 'valid';
}

export const needsRefresh = (s: SessionData, now: number, skewMs: number): boolean => s.accessExpiresAt - now <= skewMs;

export function sealSession(s: SessionData, c: Pick<ServerConfig, 'sessionSecret' | 'secureCookies'>): string {
  return seal(s, c.sessionSecret, sessionCookieName(c));
}

export function openSession(value: string | undefined | null, c: Pick<ServerConfig, 'sessionSecret' | 'secureCookies'>): SessionData | null {
  const s = unseal<SessionData>(value, c.sessionSecret, sessionCookieName(c));
  if (!s || s.v !== 1 || typeof s.accessToken !== 'string' || typeof s.refreshToken !== 'string' || typeof s.csrf !== 'string') return null;
  if (![s.accessExpiresAt, s.createdAt, s.lastActivityAt].every(Number.isFinite)) return null;
  return s;
}

/** The sealed cookie value plus its `Set-Cookie` header. The cookie lives for the absolute lifetime; idle expiry is enforced from the sealed timestamps. */
export function buildSessionCookie(s: SessionData, now: number, c: ServerConfig): { name: string; value: string; header: string } {
  const remaining = Math.max(1, Math.floor((s.createdAt + c.absoluteTimeoutMs - now) / 1000));
  const name = sessionCookieName(c);
  const value = sealSession(s, c);
  return { name, value, header: serializeCookie(name, value, { ...baseCookie(c), maxAge: remaining }) };
}

export const sessionSetCookie = (s: SessionData, now: number, c: ServerConfig): string => buildSessionCookie(s, now, c).header;

export const sessionClearCookie = (c: ServerConfig): string => clearCookie(sessionCookieName(c), baseCookie(c));

export function mfaSetCookie(ch: MfaChallenge, c: ServerConfig): string {
  return serializeCookie(mfaCookieName(c), seal(ch, c.sessionSecret, mfaCookieName(c)), { ...baseCookie(c), maxAge: MFA_TTL_SECONDS });
}

export function openMfa(value: string | undefined | null, now: number, c: Pick<ServerConfig, 'sessionSecret' | 'secureCookies'>): MfaChallenge | null {
  const ch = unseal<MfaChallenge>(value, c.sessionSecret, mfaCookieName(c));
  if (!ch || ch.v !== 1 || typeof ch.mfaToken !== 'string' || !Number.isFinite(ch.at)) return null;
  if (now - ch.at > MFA_TTL_SECONDS * 1000) return null;
  return ch;
}

export const mfaClearCookie = (c: ServerConfig): string => clearCookie(mfaCookieName(c), baseCookie(c));
