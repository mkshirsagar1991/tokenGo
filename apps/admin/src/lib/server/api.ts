import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { ApiResult } from '../problem';
import { apiRequest, type ApiCall } from './api-client';
import { getConfig } from './config';
import { openSession, sessionCookieName, sessionState, type SessionData } from './session';

/**
 * Server-component access to the API on behalf of the signed-in admin. The access token comes from the sealed session cookie and
 * never leaves the server. Token refresh happens in src/proxy.ts (server components cannot set cookies), so by the time a page
 * renders the access token has at least ~30 s left.
 */
export const getSession = cache(async (): Promise<SessionData | null> => {
  const config = getConfig();
  const jar = await cookies();
  const session = openSession(jar.get(sessionCookieName(config))?.value, config);
  if (!session || sessionState(session, Date.now(), config) !== 'valid') return null;
  return session;
});

export async function currentPath(): Promise<string> {
  return (await headers()).get('x-tg-path') ?? '/';
}

/** Sends the browser through the route handler that clears the dead cookie, then to the sign-in page. Never returns. */
export async function redirectToSignIn(reason: 'expired' | 'idle' = 'expired'): Promise<never> {
  const next = await currentPath();
  redirect(`/bff/auth/expired?reason=${reason}${next && next !== '/' ? `&next=${encodeURIComponent(next)}` : ''}`);
}

export async function serverApi<T = unknown, M = unknown>(path: string, call: Omit<ApiCall, 'accessToken'> = {}): Promise<ApiResult<T, M>> {
  const session = await getSession();
  if (!session) return redirectToSignIn();
  const res = await apiRequest<T, M>(path, { ...call, accessToken: session.accessToken });
  if (!res.ok && res.status === 401) return redirectToSignIn();
  return res;
}

export interface Me {
  id: string;
  phone_masked: string;
  permissions: string[];
}

export const getMe = cache(async (): Promise<ApiResult<Me>> => serverApi<Me>('/users/me'));

export interface AppConfig {
  environment: string;
  server_time: string;
  payments: { provider: string; test_mode: boolean; topup_min: { amount_minor: number; currency: string }; topup_max: { amount_minor: number; currency: string } };
  settings: Record<string, unknown>;
}

/** Public endpoint (no token). May be missing on an older API: callers must tolerate failure. */
export const getAppConfig = cache(async (): Promise<ApiResult<AppConfig>> => apiRequest<AppConfig>('/app-config', { timeoutMs: 4000 }));

export function csrfFor(session: SessionData | null): string {
  return session?.csrf ?? '';
}
