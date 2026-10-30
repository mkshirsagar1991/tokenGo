import { Money } from '../../../shared-kernel';
import { CancellationSnapshot, CommissionSnapshot, combineCommission, customerRefundBps, refundBpsFor, splitCommission, splitRefund } from './pricing-rules';

const inr = (paise: number) => Money.of(paise, 'INR');
const pct = (bps: number): CommissionSnapshot => ({ ruleId: null, ruleVersion: null, kind: 'PERCENT', percentBps: bps, fixedMinor: null });
const fixed = (paise: number): CommissionSnapshot => ({ ruleId: null, ruleVersion: null, kind: 'FIXED', percentBps: null, fixedMinor: BigInt(paise) });

describe('commission', () => {
  it('requirements §19 example: ₹200 at 10 % => ₹20 commission, ₹180 payable', () => {
    const { commission, net } = splitCommission(pct(1000), inr(20000));
    expect(commission.minor).toBe(2000n);
    expect(net.minor).toBe(18000n);
  });

  it('a fixed commission is a flat fee, capped at the amount', () => {
    expect(splitCommission(fixed(2500), inr(20000))).toMatchObject({ commission: { minor: 2500n }, net: { minor: 17500n } });
    const capped = splitCommission(fixed(5000), inr(3000));
    expect(capped.commission.minor).toBe(3000n);
    expect(capped.net.minor).toBe(0n);
  });

  it('always conserves the amount exactly, for any rule and amount', () => {
    for (const rule of [pct(0), pct(1), pct(333), pct(1250), pct(10000), fixed(0), fixed(1), fixed(777)]) {
      for (let amount = 0; amount <= 4000; amount += 37) {
        const { commission, net } = splitCommission(rule, inr(amount));
        expect(commission.add(net).minor).toBe(BigInt(amount));
        expect(commission.isNegative()).toBe(false);
        expect(net.isNegative()).toBe(false);
      }
    }
  });

  it('rejects negative amounts and malformed rules', () => {
    expect(() => splitCommission(pct(1000), inr(-1))).toThrow(RangeError);
    expect(() => splitCommission({ ...pct(0), percentBps: null }, inr(1))).toThrow(RangeError);
    expect(() => splitCommission({ ...fixed(0), fixedMinor: null }, inr(1))).toThrow(RangeError);
  });
});

describe('cancellation refunds', () => {
  const tiers = [
    { minHoursBefore: 24, refundBps: 10000 },
    { minHoursBefore: 2, refundBps: 5000 },
    { minHoursBefore: 0, refundBps: 0 },
  ];
  const policy: CancellationSnapshot = { policyId: null, policyVersion: 1, name: 'Platform default', tiers, noShowRefundBps: 0, providerCancelRefundBps: 10000 };

  it('picks the tier with the largest minimum that still applies', () => {
    expect(customerRefundBps(tiers, 72)).toBe(10000);
    expect(customerRefundBps(tiers, 24)).toBe(10000); // exactly at the boundary
    expect(customerRefundBps(tiers, 23.99)).toBe(5000);
    expect(customerRefundBps(tiers, 2)).toBe(5000);
    expect(customerRefundBps(tiers, 1.5)).toBe(0);
    expect(customerRefundBps(tiers, 0)).toBe(0);
  });

  it('refunds nothing when no tier applies (e.g. cancelling after the start) — never inventing a refund', () => {
    expect(customerRefundBps(tiers, -3)).toBe(0);
    expect(customerRefundBps([], 100)).toBe(0);
  });

  it('provider cancellation and no-show follow their own configured percentages', () => {
    expect(refundBpsFor(policy, 'PROVIDER', 0)).toBe(10000);
    expect(refundBpsFor(policy, 'NO_SHOW', 0)).toBe(0);
    expect(refundBpsFor({ ...policy, noShowRefundBps: 2500 }, 'NO_SHOW', 0)).toBe(2500);
    expect(refundBpsFor(policy, 'CUSTOMER', 30)).toBe(10000);
  });

  it('the refund and the retained fee always add up to the held amount', () => {
    for (const bps of [0, 1, 2500, 5000, 9999, 10000]) {
      for (const amount of [1, 99, 20000, 12345]) {
        const { refund, retained } = splitRefund(inr(amount), bps);
        expect(refund.add(retained).minor).toBe(BigInt(amount));
        expect(refund.isNegative() || retained.isNegative()).toBe(false);
      }
    }
    expect(splitRefund(inr(20000), 5000)).toMatchObject({ refund: { minor: 10000n }, retained: { minor: 10000n } });
  });
});

describe('combineCommission (one rule for a booking of several services)', () => {
  const rule = (id: string, bps: number): CommissionSnapshot => ({ ruleId: id, ruleVersion: 3, kind: 'PERCENT', percentBps: bps, fixedMinor: null });

  it('services that all resolve to the same rule keep that exact rule (id and version too)', () => {
    const r = rule('platform', 1000);
    expect(combineCommission([{ rule: r, amount: inr(20000) }, { rule: r, amount: inr(10000) }, { rule: r, amount: inr(50000) }])).toBe(r);
  });

  it('one service is just its rule', () => {
    const r = fixed(5000);
    expect(combineCommission([{ rule: r, amount: inr(30000) }])).toBe(r);
  });

  it('a special rate on ONE service blends into the same total the separate rules would have taken', () => {
    // ₹200 at 10 % = ₹20, ₹300 at 20 % = ₹60: ₹80 on ₹500 = 16 %
    const combined = combineCommission([{ rule: rule('platform', 1000), amount: inr(20000) }, { rule: rule('special', 2000), amount: inr(30000) }]);
    expect(combined).toEqual({ ruleId: null, ruleVersion: null, kind: 'PERCENT', percentBps: 1600, fixedMinor: null });
    expect(splitCommission(combined, inr(50000)).commission.minor).toBe(8000n);
  });

  it('blends a flat fee and a percentage, rounded to the nearest basis point, never above 100 %', () => {
    const combined = combineCommission([{ rule: fixed(50000), amount: inr(30000) }, { rule: pct(1000), amount: inr(10000) }]);
    // the flat fee is capped at its ₹300 service: ₹300 + ₹10 = ₹310 on ₹400
    expect(combined).toMatchObject({ kind: 'PERCENT', percentBps: 7750 });
    expect(combined.percentBps).toBeLessThanOrEqual(10_000);
  });

  it('refuses an empty list', () => {
    expect(() => combineCommission([])).toThrow(RangeError);
  });
});
