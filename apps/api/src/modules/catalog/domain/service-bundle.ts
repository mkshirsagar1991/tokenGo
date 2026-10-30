import { Money } from '../../../shared-kernel';

/** Most services one booking may combine. A sanity limit (nobody books 20 services in one visit), not a business rule. */
export const MAX_SERVICES_PER_BOOKING = 8;

/** The parts of a service the bundle needs. */
export interface BundleLine {
  id: string;
  providerId: string;
  name: string;
  price: Money;
  durationMin: number;
  bufferMin: number;
}

export interface ServiceBundle<T extends BundleLine = BundleLine> {
  /** In the order the customer chose them, duplicates removed. */
  services: T[];
  providerId: string;
  /** The sum of the prices: what is held from the customer's wallet. */
  price: Money;
  /**
   * How long the customer is there: every service, plus the rest/clean-up gap after each one EXCEPT the longest one, which
   * becomes the trailing [bufferMin]. So `durationMin + bufferMin` always equals the sum of (duration + buffer) of all lines,
   * whatever order they were chosen in: nothing is squeezed, and the calendar block does not depend on the order.
   */
  durationMin: number;
  bufferMin: number;
  /** "Haircut + Facial". */
  name: string;
}

/**
 * Combines several services of ONE provider into the single appointment a booking reserves. Pure arithmetic: no database, no
 * clock. Returns a reason string instead of throwing so the caller can pick the right error.
 */
export function bundleServices<T extends BundleLine>(lines: T[]): { ok: true; bundle: ServiceBundle<T> } | { ok: false; reason: 'EMPTY' | 'TOO_MANY' | 'MIXED_PROVIDERS' | 'MIXED_CURRENCY' } {
  const seen = new Set<string>();
  const services = lines.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  if (services.length === 0) return { ok: false, reason: 'EMPTY' };
  if (services.length > MAX_SERVICES_PER_BOOKING) return { ok: false, reason: 'TOO_MANY' };
  const first = services[0]!;
  if (services.some((s) => s.providerId !== first.providerId)) return { ok: false, reason: 'MIXED_PROVIDERS' };
  const currency = first.price.currency;
  if (services.some((s) => s.price.currency !== currency)) return { ok: false, reason: 'MIXED_CURRENCY' };

  const price = services.reduce((sum, s) => sum.add(s.price), Money.zero(currency));
  const totalMin = services.reduce((sum, s) => sum + s.durationMin + s.bufferMin, 0);
  const bufferMin = Math.max(...services.map((s) => s.bufferMin));
  return {
    ok: true,
    bundle: { services, providerId: first.providerId, price, durationMin: totalMin - bufferMin, bufferMin, name: services.map((s) => s.name).join(' + ') },
  };
}
