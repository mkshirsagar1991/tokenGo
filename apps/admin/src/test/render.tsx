import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { AppProviders } from '@/components/providers';

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: FetchCall) => { status?: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }>;

/** Replaces global fetch with a recorder. Each call is answered by `responder`; the default is 200 `{ data: {} }`. */
export function stubFetch(responder: Responder = () => ({ body: { data: {} } })) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: FetchCall = { url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = await responder(call);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...r.headers } });
  });
  vi.stubGlobal('fetch', impl);
  return { calls, impl };
}

export function renderApp(ui: ReactElement, opts: { permissions?: string[]; csrf?: string; userId?: string } = {}) {
  const utils = render(
    <AppProviders csrf={opts.csrf ?? 'csrf-test-token'} permissions={opts.permissions ?? []} idleTimeoutMs={900_000} userId={opts.userId ?? 'me-0000'}>
      {ui}
    </AppProviders>,
  );
  return { ...utils, user: userEvent.setup() };
}
