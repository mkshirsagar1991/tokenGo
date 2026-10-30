import { timingSafeEqual } from 'node:crypto';

/**
 * CSRF defence for every state-changing BFF request, in layers (any one failing rejects the request):
 *  1. the session cookie is SameSite=Strict, so cross-site requests do not carry it at all;
 *  2. the Origin (or, failing that, Referer) must be this site or an explicitly allowed origin, and Sec-Fetch-Site must not say cross-site;
 *  3. a custom header (`X-Requested-With`) that a cross-origin form/navigation cannot send;
 *  4. a per-session synchroniser token (`X-CSRF-Token`) that only this app's own pages receive.
 */
export const CSRF_HEADER = 'x-csrf-token';
export const REQUESTED_WITH_HEADER = 'x-requested-with';
export const REQUESTED_WITH_VALUE = 'tokengo-admin';

export interface OriginCheckInput {
  origin: string | null;
  referer: string | null;
  secFetchSite: string | null;
  /** The origin this server believes it is serving (from the request URL). */
  selfOrigin: string;
  allowedOrigins: readonly string[];
}

export function checkRequestOrigin(i: OriginCheckInput): boolean {
  if (i.secFetchSite && !['same-origin', 'none'].includes(i.secFetchSite)) return false;
  const allowed = new Set([i.selfOrigin, ...i.allowedOrigins]);
  let candidate = i.origin;
  if (!candidate || candidate === 'null') {
    if (!i.referer) return false;
    try {
      candidate = new URL(i.referer).origin;
    } catch {
      return false;
    }
  }
  return allowed.has(candidate);
}

export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hasRequestedWithHeader(headers: Pick<Headers, 'get'>): boolean {
  return headers.get(REQUESTED_WITH_HEADER) === REQUESTED_WITH_VALUE;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isStateChanging = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());
