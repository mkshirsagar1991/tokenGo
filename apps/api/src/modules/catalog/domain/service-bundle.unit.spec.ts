import { Money } from '../../../shared-kernel';
import { BundleLine, MAX_SERVICES_PER_BOOKING, bundleServices } from './service-bundle';

const line = (id: string, name: string, rupees: number, durationMin: number, bufferMin = 0, providerId = 'p1', currency = 'INR'): BundleLine => ({
  id,
  providerId,
  name,
  price: Money.of(BigInt(rupees * 100), currency),
  durationMin,
  bufferMin,
});

describe('bundleServices (several services in one booking)', () => {
  it('adds the prices and the times of a salon visit: haircut + shave + head massage', () => {
    const r = bundleServices([line('a', 'Haircut', 300, 30, 5), line('b', 'Shave', 100, 15, 0), line('c', 'Head massage', 200, 20, 5)]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.bundle.price).toEqual(Money.of(60_000n, 'INR'));
    expect(r.bundle.name).toBe('Haircut + Shave + Head massage');
    // 30+5 + 15+0 + 20+5 = 75 minutes of calendar in total
    expect(r.bundle.durationMin + r.bundle.bufferMin).toBe(75);
    expect(r.bundle.bufferMin).toBe(5);
    expect(r.bundle.durationMin).toBe(70);
  });

  it('a car visit: wash + air check + tyre change', () => {
    const r = bundleServices([line('w', 'Car wash', 400, 45, 10), line('a', 'Air check', 50, 10, 0), line('t', 'Tyre change', 800, 40, 10)]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.bundle.price.minor).toBe(125_000n);
    expect(r.bundle.durationMin + r.bundle.bufferMin).toBe(45 + 10 + 10 + 40 + 10);
  });

  it('the calendar block does not depend on the order the customer ticked the services in', () => {
    const lines = [line('a', 'A', 100, 30, 15), line('b', 'B', 100, 20, 0), line('c', 'C', 100, 10, 5)];
    const total = (ls: BundleLine[]) => {
      const r = bundleServices(ls);
      if (!r.ok) throw new Error('expected ok');
      return [r.bundle.durationMin, r.bundle.bufferMin, r.bundle.price.minor];
    };
    expect(total([lines[0]!, lines[1]!, lines[2]!])).toEqual(total([lines[2]!, lines[0]!, lines[1]!]));
  });

  it('a single service is exactly that service (nothing changes for the old one-service booking)', () => {
    const r = bundleServices([line('a', 'Haircut', 300, 30, 5)]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.bundle.durationMin).toBe(30);
    expect(r.bundle.bufferMin).toBe(5);
    expect(r.bundle.name).toBe('Haircut');
    expect(r.bundle.price.minor).toBe(30_000n);
  });

  it('the same service ticked twice counts once', () => {
    const r = bundleServices([line('a', 'Haircut', 300, 30, 5), line('a', 'Haircut', 300, 30, 5)]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.bundle.services).toHaveLength(1);
    expect(r.bundle.price.minor).toBe(30_000n);
  });

  it('free services are fine (the bundle is simply cheaper)', () => {
    const r = bundleServices([line('a', 'Consultation', 0, 10), line('b', 'Facial', 500, 40)]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.bundle.price.minor).toBe(50_000n);
  });

  it.each([
    ['nothing chosen', [], 'EMPTY'],
    ['services of two different businesses', [line('a', 'A', 1, 10, 0, 'p1'), line('b', 'B', 1, 10, 0, 'p2')], 'MIXED_PROVIDERS'],
    ['two currencies', [line('a', 'A', 1, 10, 0, 'p1', 'INR'), line('b', 'B', 1, 10, 0, 'p1', 'USD')], 'MIXED_CURRENCY'],
  ] as const)('refuses %s', (_label, lines, reason) => {
    expect(bundleServices([...lines])).toEqual({ ok: false, reason });
  });

  it(`refuses more than ${MAX_SERVICES_PER_BOOKING} services`, () => {
    const many = Array.from({ length: MAX_SERVICES_PER_BOOKING + 1 }, (_, i) => line(`s${i}`, `S${i}`, 1, 10));
    expect(bundleServices(many)).toEqual({ ok: false, reason: 'TOO_MANY' });
  });
});
