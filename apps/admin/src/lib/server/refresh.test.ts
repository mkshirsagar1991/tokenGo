// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRefreshCoordinator, type RefreshCallResult } from './refresh';
import { newSession } from './session';

const tokens = (n: number) => ({ access_token: `AT-${n}`, refresh_token: `RT-${n}`, expires_in: 900 });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('refresh coordinator (the API rotates refresh tokens)', () => {
  it('shares ONE API call between concurrent refreshes with the same token (single-flight)', async () => {
    const gate = deferred<RefreshCallResult>();
    const call = vi.fn(() => gate.promise);
    const c = createRefreshCoordinator({ call, now: () => 1000 });
    const s = newSession(tokens(1), 0);

    const pending = Promise.all([c.refresh(s), c.refresh(s), c.refresh(s), c.refresh(s)]);
    gate.resolve({ kind: 'ok', tokens: tokens(2) });
    const results = await pending;

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('RT-1');
    for (const r of results) expect(r).toMatchObject({ kind: 'ok', session: { accessToken: 'AT-2', refreshToken: 'RT-2' } });
  });

  it('gives a late request that still carries the OLD token the new tokens instead of replaying the old one at the API', async () => {
    const call = vi.fn(async (): Promise<RefreshCallResult> => ({ kind: 'ok', tokens: tokens(2) }));
    let now = 1000;
    const c = createRefreshCoordinator({ call, now: () => now, memoTtlMs: 20_000 });
    const s = newSession(tokens(1), 0);
    await c.refresh(s);
    now += 3000; // the browser had not applied the new cookie yet
    const late = await c.refresh(s);
    expect(call).toHaveBeenCalledTimes(1);
    expect(late).toMatchObject({ kind: 'ok', session: { refreshToken: 'RT-2' } });
  });

  it('forgets the memo after its TTL (then a real call is made again)', async () => {
    const call = vi.fn(async (): Promise<RefreshCallResult> => ({ kind: 'ok', tokens: tokens(2) }));
    let now = 1000;
    const c = createRefreshCoordinator({ call, now: () => now, memoTtlMs: 5000 });
    const s = newSession(tokens(1), 0);
    await c.refresh(s);
    now += 6000;
    await c.refresh(s);
    expect(call).toHaveBeenCalledTimes(2);
    expect(c._size().recent).toBeLessThanOrEqual(1);
  });

  it('keeps different sessions apart', async () => {
    const call = vi.fn(async (t: string): Promise<RefreshCallResult> => ({ kind: 'ok', tokens: { access_token: `new-${t}`, refresh_token: `next-${t}`, expires_in: 900 } }));
    const c = createRefreshCoordinator({ call, now: () => 1 });
    const [a, b] = await Promise.all([c.refresh(newSession(tokens(1), 0)), c.refresh(newSession(tokens(7), 0))]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(a).toMatchObject({ session: { refreshToken: 'next-RT-1' } });
    expect(b).toMatchObject({ session: { refreshToken: 'next-RT-7' } });
  });

  it.each(['invalid', 'conflict', 'unavailable'] as const)('reports %s without inventing a session, and does not memoise it', async (kind) => {
    const call = vi.fn(async (): Promise<RefreshCallResult> => ({ kind }));
    const c = createRefreshCoordinator({ call, now: () => 1 });
    const s = newSession(tokens(1), 0);
    expect(await c.refresh(s)).toEqual({ kind });
    expect(await c.refresh(s)).toEqual({ kind });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('keeps the CSRF secret and creation time across a refresh', async () => {
    const c = createRefreshCoordinator({ call: async () => ({ kind: 'ok', tokens: tokens(2) }), now: () => 5000 });
    const s = newSession(tokens(1), 100);
    const r = await c.refresh(s);
    expect(r.kind === 'ok' && r.session.csrf).toBe(s.csrf);
    expect(r.kind === 'ok' && r.session.createdAt).toBe(100);
  });
});
