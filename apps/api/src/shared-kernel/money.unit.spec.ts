import { Money } from './money';

describe('Money', () => {
  const inr = (n: number | bigint) => Money.of(n, 'INR');

  it('rejects floats and invalid currencies', () => {
    expect(() => inr(10.5)).toThrow(RangeError);
    expect(() => inr(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => Money.of(1, 'inr')).toThrow(RangeError);
    expect(() => Money.of(1, 'RUPEE')).toThrow(RangeError);
  });

  it('adds and subtracts exactly', () => {
    expect(inr(20000).add(inr(5)).minor).toBe(20005n);
    expect(inr(20000).subtract(inr(20001)).minor).toBe(-1n);
  });

  it('refuses to mix currencies', () => {
    expect(() => inr(1).add(Money.of(1, 'USD'))).toThrow(/Currency mismatch/);
    expect(() => inr(1).compare(Money.of(1, 'USD'))).toThrow(/Currency mismatch/);
  });

  describe('commission (requirements §19: ₹200 @ 10% → ₹180 payable / ₹20 commission)', () => {
    it('splits the documented example exactly', () => {
      const { commission, net } = inr(20000).splitCommissionBps(1000);
      expect(commission.minor).toBe(2000n);
      expect(net.minor).toBe(18000n);
    });

    it('rounds half-up and always satisfies commission + net === amount', () => {
      // 1005 paise * 12.5% = 125.625 -> 126
      const { commission, net } = inr(1005).splitCommissionBps(1250);
      expect(commission.minor).toBe(126n);
      expect(commission.add(net).equals(inr(1005))).toBe(true);
      // exact half: 1 paise * 50% = 0.5 -> rounds up to 1
      expect(inr(1).percentBps(5000).minor).toBe(1n);
    });

    it('holds the invariant for a wide sweep of amounts and rates', () => {
      for (let amount = 0; amount <= 5000; amount += 7) {
        for (const bps of [0, 1, 250, 999, 1000, 1250, 3333, 5000, 9999, 10000]) {
          const total = inr(amount);
          const { commission, net } = total.splitCommissionBps(bps);
          expect(commission.add(net).equals(total)).toBe(true);
          expect(commission.isNegative()).toBe(false);
          expect(net.isNegative()).toBe(false);
          expect(commission.compare(total)).toBeLessThanOrEqual(0);
        }
      }
    });

    it('validates basis points and non-negativity', () => {
      expect(() => inr(100).percentBps(-1)).toThrow(RangeError);
      expect(() => inr(100).percentBps(10001)).toThrow(RangeError);
      expect(() => inr(100).percentBps(10.5)).toThrow(RangeError);
      expect(() => inr(-100).percentBps(1000)).toThrow(RangeError);
    });
  });

  it('serialises to the wire format and guards the safe-integer range', () => {
    expect(JSON.parse(JSON.stringify({ price: inr(20000) }))).toEqual({
      price: { amount_minor: 20000, currency: 'INR' },
    });
    expect(() => inr(BigInt(Number.MAX_SAFE_INTEGER) + 1n).toJSON()).toThrow(RangeError);
  });

  it('parses the wire format strictly (no strings, no floats)', () => {
    expect(Money.fromJson({ amount_minor: 100, currency: 'INR' }).minor).toBe(100n);
    expect(() => Money.fromJson({ amount_minor: '100', currency: 'INR' })).toThrow(RangeError);
    expect(() => Money.fromJson({ amount_minor: 1.5, currency: 'INR' })).toThrow(RangeError);
  });
});
