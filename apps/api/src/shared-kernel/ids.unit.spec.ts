import { isUuid, uuidv7 } from './ids';

describe('uuidv7', () => {
  it('produces RFC 9562 version-7, variant-10 UUIDs', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is time-ordered and unique even for many ids in the same millisecond', () => {
    const now = Date.now() + 10_000_000; // far-future base so this test is independent of earlier calls
    const ids = Array.from({ length: 2000 }, () => uuidv7(now));
    expect(new Set(ids).size).toBe(ids.length);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('orders ids from later timestamps after earlier ones', () => {
    const base = Date.now() + 20_000_000;
    const a = uuidv7(base);
    const b = uuidv7(base + 5);
    expect(b > a).toBe(true);
  });

  it('isUuid rejects junk', () => {
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});
