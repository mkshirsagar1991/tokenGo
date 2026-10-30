import { networkProblem, problemFromBody, type ApiResult } from '../problem';
import { getConfig, type ServerConfig } from './config';

/** Server-side client for the TokenGo API. The browser never calls the API; only this module (and the BFF built on it) does. */
export interface ApiCall {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  accessToken?: string;
  headers?: Record<string, string>;
  /** Original client address, forwarded as X-Forwarded-For so the API's per-IP throttles see the real client (only when TRUST_PROXY=true). */
  clientIp?: string;
  timeoutMs?: number;
}

export interface RawApiResponse {
  status: number;
  contentType: string | null;
  text: string;
  requestId: string | null;
  retryAfter: string | null;
  replayed: boolean;
}

export type RawOutcome = { ok: true; response: RawApiResponse } | { ok: false; reason: 'network' | 'timeout' };

export function buildUrl(base: string, path: string, query?: ApiCall['query']): string {
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export async function apiFetchRaw(path: string, call: ApiCall = {}, config: Pick<ServerConfig, 'apiBaseUrl' | 'apiTimeoutMs'> = getConfig()): Promise<RawOutcome> {
  const headers: Record<string, string> = { accept: 'application/json', ...call.headers };
  if (call.accessToken) headers.authorization = `Bearer ${call.accessToken}`;
  if (call.clientIp) headers['x-forwarded-for'] = call.clientIp;
  let body: string | undefined;
  if (call.body !== undefined) {
    body = JSON.stringify(call.body);
    headers['content-type'] = 'application/json';
  }
  try {
    const res = await fetch(buildUrl(config.apiBaseUrl, path, call.query), {
      method: call.method ?? 'GET',
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(call.timeoutMs ?? config.apiTimeoutMs),
    });
    return {
      ok: true,
      response: {
        status: res.status,
        contentType: res.headers.get('content-type'),
        text: await res.text(),
        requestId: res.headers.get('x-request-id'),
        retryAfter: res.headers.get('retry-after'),
        replayed: res.headers.get('idempotent-replayed') === 'true',
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network' };
  }
}

export function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function apiRequest<T = unknown, M = unknown>(path: string, call: ApiCall = {}, config?: ServerConfig): Promise<ApiResult<T, M>> {
  const out = await apiFetchRaw(path, call, config);
  if (!out.ok) {
    return { ok: false, status: 0, problem: networkProblem(out.reason === 'timeout' ? 'The TokenGo API took too long to answer. Try again.' : undefined) };
  }
  const { response } = out;
  const body = parseJson(response.text);
  if (response.status >= 200 && response.status < 300) {
    const envelope = body as { data?: T; meta?: M } | undefined;
    if (response.status === 204 || body === undefined) return { ok: true, status: response.status, data: undefined as T, requestId: response.requestId ?? undefined };
    // The API wraps results as { data, meta? }; a few endpoints (health, reports/daily) return a bare object or extra siblings.
    const hasEnvelope = envelope !== null && typeof envelope === 'object' && 'data' in envelope;
    return {
      ok: true,
      status: response.status,
      data: (hasEnvelope ? envelope.data : body) as T,
      meta: (hasEnvelope ? envelope.meta : undefined) as M | undefined,
      requestId: response.requestId ?? undefined,
    };
  }
  const problem = problemFromBody(response.status, body, response.requestId);
  if (response.retryAfter && problem.retryAfterSeconds === undefined && Number.isFinite(Number(response.retryAfter))) problem.retryAfterSeconds = Number(response.retryAfter);
  return { ok: false, status: response.status, problem };
}
