import { describe, expect, it } from 'vitest';
import { formatBps, formatInr, formatMoney, groupIndian, parsePercentToBps, parseRupeesToMinor, sumMinor } from './money';

describe('Indian digit grouping', () => {
  it.each([
    ['0', '0'],
    ['999', '999'],
    ['1000', '1,000'],
    ['12345', '12,345'],
    ['100000', '1,00,000'],
    ['12500000', '1,25,00,000'],
    ['123456789', '12,34,56,789'],
  ])('%s -> %s', (input, expected) => expect(groupIndian(input)).toBe(expected));
});

describe('formatInr (integer paise in, no floating point)', () => {
  it('formats the documented example', () => expect(formatInr(12_500_000)).toBe('₹1,25,000'));
  it('shows paise only when they are not zero', () => {
    expect(formatInr(12_500_050)).toBe('₹1,25,000.50');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(100)).toBe('₹1');
    expect(formatInr(100, { fraction: 'always' })).toBe('₹1.00');
  });
  it('pads single-digit paise', () => expect(formatInr(10_005)).toBe('₹100.05'));
  it('handles zero and negatives', () => {
    expect(formatInr(0)).toBe('₹0');
    expect(formatInr(-12_345)).toBe('-₹123.45');
  });
  it('is exact beyond what a float can hold (bigint)', () => {
    expect(formatInr(9_007_199_254_740_993n)).toBe('₹9,00,71,99,25,47,409.93');
  });
  it('accepts integer strings and rejects anything else', () => {
    expect(formatInr('250000')).toBe('₹2,500');
    expect(() => formatInr(1.5)).toThrow(RangeError);
    expect(() => formatInr('12.5')).toThrow(RangeError);
    expect(() => formatInr(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
  it('can omit the symbol', () => expect(formatInr(250_000, { symbol: false })).toBe('2,500'));
});

describe('formatMoney', () => {
  it('formats INR and other currencies, and tolerates null', () => {
    expect(formatMoney({ amount_minor: 30_000, currency: 'INR' })).toBe('₹300');
    expect(formatMoney({ amount_minor: 123_456, currency: 'USD' })).toBe('USD 1,234.56');
    expect(formatMoney(null)).toBe('—');
  });
});

describe('parseRupeesToMinor', () => {
  it.each([
    ['1250', 125_000],
    ['1,250.5', 125_050],
    ['₹ 99.99', 9_999],
    ['0.05', 5],
    ['  300 ', 30_000],
    ['1,25,000', 12_500_000],
  ])('%s -> %i paise', (input, minor) => expect(parseRupeesToMinor(input)).toEqual({ ok: true, value: minor }));

  it('never goes through floating point (0.1 + 0.2 style traps)', () => {
    expect(parseRupeesToMinor('0.29')).toEqual({ ok: true, value: 29 });
    expect(parseRupeesToMinor('1.15')).toEqual({ ok: true, value: 115 });
    expect(parseRupeesToMinor('4.35')).toEqual({ ok: true, value: 435 });
  });

  it.each(['', 'abc', '-5', '1e3', '1.234', '12.', '.5', '1..2', '1,2,3x'])('rejects %j', (input) => expect(parseRupeesToMinor(input).ok).toBe(false));

  it('rejects zero unless allowed, and absurdly large amounts', () => {
    expect(parseRupeesToMinor('0')).toMatchObject({ ok: false });
    expect(parseRupeesToMinor('0', { allowZero: true })).toEqual({ ok: true, value: 0 });
    expect(parseRupeesToMinor('99999999999999999999')).toMatchObject({ ok: false });
  });

  it('explains too many decimals specifically', () => {
    expect(parseRupeesToMinor('1.234')).toEqual({ ok: false, error: 'Use at most two decimal places (paise).' });
  });
});

describe('basis points', () => {
  it('formats', () => {
    expect(formatBps(1000)).toBe('10%');
    expect(formatBps(1250)).toBe('12.5%');
    expect(formatBps(1)).toBe('0.01%');
    expect(formatBps(0)).toBe('0%');
    expect(formatBps(10000)).toBe('100%');
    expect(() => formatBps(-1)).toThrow();
    expect(() => formatBps(1.5)).toThrow();
  });
  it('parses percentages into integer bps', () => {
    expect(parsePercentToBps('10')).toEqual({ ok: true, value: 1000 });
    expect(parsePercentToBps('12.5%')).toEqual({ ok: true, value: 1250 });
    expect(parsePercentToBps('0.01')).toEqual({ ok: true, value: 1 });
    expect(parsePercentToBps('100')).toEqual({ ok: true, value: 10000 });
  });
  it('rejects out-of-range and malformed input', () => {
    expect(parsePercentToBps('100.01').ok).toBe(false);
    expect(parsePercentToBps('101').ok).toBe(false);
    expect(parsePercentToBps('-1').ok).toBe(false);
    expect(parsePercentToBps('1.234').ok).toBe(false);
    expect(parsePercentToBps('').ok).toBe(false);
    expect(parsePercentToBps('abc').ok).toBe(false);
  });
});

describe('sumMinor', () => {
  it('adds exactly, mixing numbers, strings and bigints', () => {
    expect(sumMinor([1, '2', 3n])).toBe(6n);
    expect(sumMinor([])).toBe(0n);
    expect(sumMinor([9_007_199_254_740_991, 9_007_199_254_740_991])).toBe(18_014_398_509_481_982n);
  });
});
