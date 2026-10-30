import { describe, expect, it } from 'vitest';
import { shortId } from './format';

describe('shortId', () => {
  // Two ids created a few seconds apart by the real API (UUIDv7): same first 8 characters, different random tails.
  const a = '01a115f4-735e-70f6-9e5a-ccbdcee7423c';
  const b = '01a115f4-d09f-74cc-9c58-922eb2f28997';

  it('tells apart ids that were created within the same minute', () => {
    expect(a.slice(0, 8)).toBe(b.slice(0, 8)); // the premise: a prefix cannot distinguish them
    expect(shortId(a)).not.toBe(shortId(b));
    expect(shortId(a)).toBe('…cee7423c');
  });

  it('keeps the first 8 characters of anything that is not a UUID', () => {
    expect(shortId('pay_TkvtUGELcKLpmE')).toBe('pay_Tkvt');
  });

  it('shows a dash for a missing id', () => {
    expect(shortId(null)).toBe('—');
    expect(shortId(undefined)).toBe('—');
    expect(shortId('')).toBe('—');
  });
});
