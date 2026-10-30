// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkAllowed, normalizePath } from './allowlist';
import { checkRequestOrigin, hasRequestedWithHeader, isStateChanging, safeEqual } from './csrf';

const base = { origin: 'http://localhost:3100', referer: null, secFetchSite: 'same-origin', selfOrigin: 'http://localhost:3100', allowedOrigins: [] as string[] };

describe('request origin check', () => {
  it('accepts the site itself', () => expect(checkRequestOrigin(base)).toBe(true));
  it('rejects another origin', () => expect(checkRequestOrigin({ ...base, origin: 'https://evil.example' })).toBe(false));
  it('rejects look-alikes of the allowed origin', () => {
    expect(checkRequestOrigin({ ...base, origin: 'http://localhost:3100.evil.example' })).toBe(false);
    expect(checkRequestOrigin({ ...base, origin: 'http://localhost:31000' })).toBe(false);
    expect(checkRequestOrigin({ ...base, origin: 'https://localhost:3100' })).toBe(false);
  });
  it('rejects a browser that says the request is cross-site, even with a matching Origin', () => {
    expect(checkRequestOrigin({ ...base, secFetchSite: 'cross-site' })).toBe(false);
    expect(checkRequestOrigin({ ...base, secFetchSite: 'same-site' })).toBe(false);
  });
  it('falls back to Referer when Origin is absent or "null", and rejects when neither is usable', () => {
    expect(checkRequestOrigin({ ...base, origin: null, referer: 'http://localhost:3100/providers' })).toBe(true);
    expect(checkRequestOrigin({ ...base, origin: 'null', referer: 'http://localhost:3100/x' })).toBe(true);
    expect(checkRequestOrigin({ ...base, origin: null, referer: 'https://evil.example/x' })).toBe(false);
    expect(checkRequestOrigin({ ...base, origin: null, referer: null })).toBe(false);
    expect(checkRequestOrigin({ ...base, origin: null, referer: 'not a url' })).toBe(false);
  });
  it('allows explicitly configured origins (TLS terminated upstream)', () => {
    expect(checkRequestOrigin({ ...base, origin: 'https://admin.example.com', allowedOrigins: ['https://admin.example.com'] })).toBe(true);
    expect(checkRequestOrigin({ ...base, origin: 'https://other.example.com', allowedOrigins: ['https://admin.example.com'] })).toBe(false);
  });
});

describe('csrf token and header', () => {
  it('compares in constant time and never accepts empty values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual(null, 'abc')).toBe(false);
    expect(safeEqual('abc', undefined)).toBe(false);
  });
  it('requires the marker header', () => {
    expect(hasRequestedWithHeader(new Headers({ 'x-requested-with': 'tokengo-admin' }))).toBe(true);
    expect(hasRequestedWithHeader(new Headers({ 'x-requested-with': 'XMLHttpRequest' }))).toBe(false);
    expect(hasRequestedWithHeader(new Headers())).toBe(false);
  });
  it('treats everything but GET/HEAD/OPTIONS as state-changing', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) expect(isStateChanging(m)).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(isStateChanging(m)).toBe(false);
  });
});

const id = '01a11551-74f2-7f67-8d6c-320744186e68';

describe('BFF allowlist (default deny)', () => {
  it('allows admin reads', () => {
    expect(checkAllowed('GET', ['admin', 'providers'])).toEqual({ allowed: true, path: 'admin/providers' });
    expect(checkAllowed('GET', ['admin', 'payments', 'refunds', id]).allowed).toBe(true);
  });

  it('allows exactly the named admin writes', () => {
    for (const [m, p] of [
      ['POST', `admin/providers/${id}/approve`],
      ['POST', `admin/providers/${id}/reject`],
      ['POST', 'admin/payments/refunds'],
      ['POST', 'admin/payouts/run'],
      ['POST', `admin/payouts/providers/${id}/freeze`],
      ['POST', `admin/payouts/${id}/refresh`],
      ['PATCH', `admin/categories/${id}`],
      ['POST', 'admin/commission-rules'],
      ['PUT', 'admin/settings/support.hours'],
      ['POST', `admin/users/${id}/roles/revoke`],
    ] as const) {
      expect(checkAllowed(m, p.split('/')).allowed, `${m} ${p}`).toBe(true);
    }
  });

  it('refuses everything outside admin/*, including auth and customer routes', () => {
    for (const p of [['auth', 'logout'], ['auth', 'admin', 'login'], ['users', 'me'], ['wallet'], ['appointments', id, 'cancel'], ['providers', id, 'approve']]) {
      expect(checkAllowed('GET', p).allowed).toBe(false);
      expect(checkAllowed('POST', p).allowed).toBe(false);
    }
  });

  it('refuses unlisted admin writes and the wrong method', () => {
    expect(checkAllowed('POST', ['admin', 'providers', id, 'delete']).allowed).toBe(false);
    expect(checkAllowed('DELETE', ['admin', 'providers', id])).toEqual({ allowed: false, reason: 'method' });
    expect(checkAllowed('PUT', ['admin', 'payouts', 'run']).allowed).toBe(false);
    expect(checkAllowed('PATCH', ['admin', 'providers', id]).allowed).toBe(false);
    expect(checkAllowed('POST', ['admin', 'providers', 'not-a-uuid', 'approve']).allowed).toBe(false);
  });

  it('refuses path tricks', () => {
    expect(normalizePath(['admin', '..', 'auth', 'logout'])).toBeNull();
    expect(normalizePath(['admin', '.', 'providers'])).toBeNull();
    expect(normalizePath(['admin', 'a/b'])).toBeNull();
    expect(normalizePath(['admin', 'providers?x=1'])).toBeNull();
    expect(normalizePath(['admin', 'providers%2f..%2fauth'])).toBeNull();
    expect(normalizePath([])).toBeNull();
    expect(checkAllowed('GET', ['admin', '..', 'users', 'me']).allowed).toBe(false);
  });
});
