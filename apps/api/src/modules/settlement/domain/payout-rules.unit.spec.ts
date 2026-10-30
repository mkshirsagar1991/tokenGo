import { isValidAccountNumber, isValidHolderName, isValidIfsc, maskAccountNumber, namesMatch, normalizeAccountNumber, normalizeHolderName, normalizeIfsc, pickBatch, retryDelayHours } from './payout-rules';

describe('bank detail validation', () => {
  it.each(['HDFC0001234', 'SBIN0ABC123', 'ICIC0000001'])('accepts the IFSC %s', (v) => expect(isValidIfsc(v)).toBe(true));
  it.each(['hdfc0001234', 'HDFC1001234', 'HDFC000123', 'HDFC00012345', 'HDF00001234', '', 'HDFC0 01234'])('rejects the IFSC "%s"', (v) => expect(isValidIfsc(v)).toBe(false));

  it('normalises before validating (case, spaces, dashes)', () => {
    expect(normalizeIfsc('  hdfc0001234 ')).toBe('HDFC0001234');
    expect(normalizeAccountNumber(' 1234 5678-9012 ')).toBe('123456789012');
    expect(normalizeHolderName('  Riya   Sharma ')).toBe('Riya Sharma');
  });

  it.each(['123456789', '12345678901234567890'.slice(0, 18)])('accepts the account number %s', (v) => expect(isValidAccountNumber(v)).toBe(true));
  it.each(['12345678', '1234567890123456789', '12345678a', '', '1234 56789', '١٢٣٤٥٦٧٨٩'])('rejects the account number "%s"', (v) => expect(isValidAccountNumber(v)).toBe(false));

  it.each(['Riya Sharma', "D'Souza & Sons", 'ABC Salon Pvt. Ltd.', 'अनु शर्मा', 'Ng'])('accepts the holder name "%s"', (v) => expect(isValidHolderName(v)).toBe(true));
  it.each(['', 'A', '12345', 'R<script>', 'x'.repeat(101), '-Riya', 'Riya;DROP'])('rejects the holder name "%s"', (v) => expect(isValidHolderName(v)).toBe(false));

  it('shows only the last four digits', () => {
    expect(maskAccountNumber('4321')).toBe('XXXXXX4321');
  });
});

describe('does the bank\'s registered name belong to the person we were told? (a check against paying a stranger)', () => {
  it.each([
    ['Riya Sharma', 'RIYA SHARMA'],
    ['Riya Sharma', 'SHARMA RIYA'],
    ['Riya Sharma', 'Mrs. Riya Kumari Sharma'], // the bank registers more words
    ['Riya Kumari Sharma', 'Riya Sharma'], // or fewer
    ['ABC Salon', 'M/S ABC SALON'],
    ['Dr. Anil Rao', 'ANIL RAO'],
    ['D\'Souza & Sons', 'DSOUZA SONS'],
  ])('"%s" ~ "%s"', (typed, atBank) => expect(namesMatch(typed, atBank)).toBe(true));

  it.each([
    ['Riya Sharma', 'SOMEONE ELSE'],
    ['Riya Sharma', 'Riya Verma'], // a shared first name is not enough
    ['Riya Sharma', 'Sharma Traders'],
    ['Riya Sharma', ''],
    ['', 'Riya Sharma'],
    ['Mr', 'Mr'], // nothing left once honorifics are dropped
  ])('"%s" !~ "%s"', (typed, atBank) => expect(namesMatch(typed, atBank)).toBe(false));
});

describe('batching payables into payouts', () => {
  const c = (id: string, minor: number) => ({ id, netMinor: BigInt(minor) });

  it('packs oldest-first up to the cap and stops at the first one that does not fit (older money is never leapfrogged)', () => {
    expect(pickBatch([c('a', 60), c('b', 50), c('c', 40)], 100n)).toEqual({ ids: ['a'], total: 60n });
    expect(pickBatch([c('a', 60), c('b', 40), c('c', 5)], 100n)).toEqual({ ids: ['a', 'b'], total: 100n });
    expect(pickBatch([c('a', 10), c('b', 20), c('c', 30)], 1_000n)).toEqual({ ids: ['a', 'b', 'c'], total: 60n });
  });

  it('pays a single payable that is larger than the cap alone, rather than stranding it forever', () => {
    expect(pickBatch([c('big', 500), c('b', 10)], 100n)).toEqual({ ids: ['big'], total: 500n });
  });

  it('handles nothing to pay', () => {
    expect(pickBatch([], 100n)).toEqual({ ids: [], total: 0n });
  });

  it('never loses or invents money: the batch total is exactly the sum of the picked payables', () => {
    for (let i = 0; i < 200; i++) {
      const items = Array.from({ length: 1 + (i % 12) }, (_, k) => c(`p${k}`, 1 + ((i * 7919 + k * 104729) % 90_000)));
      const cap = BigInt(1 + ((i * 31) % 150_000));
      const { ids, total } = pickBatch(items, cap);
      expect(total).toBe(items.filter((x) => ids.includes(x.id)).reduce((s, x) => s + x.netMinor, 0n));
      expect(ids).toEqual(items.slice(0, ids.length).map((x) => x.id)); // always a PREFIX: strictly oldest-first
      if (ids.length > 1) expect(total <= cap).toBe(true);
    }
  });
});

describe('retry timing after failed payouts', () => {
  it('waits 1h, 2h, 4h … and never more than 24h', () => {
    expect([1, 2, 3, 4, 5, 6, 10, 50].map(retryDelayHours)).toEqual([1, 2, 4, 8, 16, 24, 24, 24]);
    expect(retryDelayHours(0)).toBe(1);
  });
});
