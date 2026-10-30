import { randomBytes } from 'node:crypto';
import { QR_TTL_SECONDS, derivePin, issueQrToken, pinMatches, verifyQrToken } from './arrival-token';
import { ActorKind, BookingCommand, BookingStatus, TERMINAL, TRANSITIONS, isTerminal, nextStatus } from './booking-state';

const ALL_STATUSES: BookingStatus[] = ['DRAFT', 'PAYMENT_PENDING', 'PAYMENT_HELD', 'REQUESTED', 'CONFIRMED', 'PROVIDER_REJECTED', 'EXPIRED', 'CUSTOMER_CANCELLED', 'PROVIDER_CANCELLED', 'NO_SHOW', 'CUSTOMER_ARRIVED', 'SERVICE_STARTED', 'SERVICE_COMPLETED', 'DISPUTED', 'CLOSED'];
const ACTORS: ActorKind[] = ['CUSTOMER', 'PROVIDER', 'ADMIN', 'SYSTEM'];

describe('booking state machine', () => {
  it('follows the happy path REQUESTED -> CONFIRMED -> ARRIVED -> STARTED -> COMPLETED -> CLOSED', () => {
    let s: BookingStatus = 'REQUESTED';
    s = nextStatus(s, 'APPROVE', 'PROVIDER');
    s = nextStatus(s, 'VERIFY_ARRIVAL', 'PROVIDER');
    s = nextStatus(s, 'START', 'PROVIDER');
    s = nextStatus(s, 'COMPLETE', 'PROVIDER');
    s = nextStatus(s, 'SETTLE', 'SYSTEM');
    expect(s).toBe('CLOSED');
  });

  it('supports every exit branch from REQUESTED and CONFIRMED', () => {
    expect(nextStatus('REQUESTED', 'REJECT', 'PROVIDER')).toBe('PROVIDER_REJECTED');
    expect(nextStatus('REQUESTED', 'EXPIRE', 'SYSTEM')).toBe('EXPIRED');
    expect(nextStatus('REQUESTED', 'CUSTOMER_CANCEL', 'CUSTOMER')).toBe('CUSTOMER_CANCELLED');
    expect(nextStatus('CONFIRMED', 'CUSTOMER_CANCEL', 'CUSTOMER')).toBe('CUSTOMER_CANCELLED');
    expect(nextStatus('CONFIRMED', 'PROVIDER_CANCEL', 'PROVIDER')).toBe('PROVIDER_CANCELLED');
    expect(nextStatus('CONFIRMED', 'PROVIDER_CANCEL', 'ADMIN')).toBe('PROVIDER_CANCELLED');
    expect(nextStatus('CONFIRMED', 'MARK_NO_SHOW', 'PROVIDER')).toBe('NO_SHOW');
  });

  it('refuses EVERY (status, command, actor) combination that is not explicitly listed', () => {
    const commands = Object.keys(TRANSITIONS) as BookingCommand[];
    let allowed = 0;
    let refused = 0;
    for (const status of ALL_STATUSES) {
      for (const command of commands) {
        for (const actor of ACTORS) {
          const t = TRANSITIONS[command];
          const legal = t.from.includes(status) && t.actors.includes(actor);
          if (legal) {
            expect(nextStatus(status, command, actor)).toBe(t.to);
            allowed++;
          } else {
            expect(() => nextStatus(status, command, actor)).toThrow(/INVALID_STATE_TRANSITION|Cannot|may not/);
            refused++;
          }
        }
      }
    }
    // 1 APPROVE + 1 REJECT + 1 EXPIRE + 2 CUSTOMER_CANCEL + 2 PROVIDER_CANCEL (provider|admin) + 1 NO_SHOW
    // + 1 VERIFY_ARRIVAL + 1 START + 1 COMPLETE + 2 SETTLE (system|customer) + 1 DISPUTE + 1 RESOLVE_DISPUTE = 15
    expect(allowed).toBe(15);
    expect(refused).toBe(ALL_STATUSES.length * commands.length * ACTORS.length - allowed);
  });

  it('terminal states offer no way out', () => {
    for (const status of TERMINAL) {
      expect(isTerminal(status)).toBe(true);
      for (const command of Object.keys(TRANSITIONS) as BookingCommand[]) {
        for (const actor of ACTORS) expect(() => nextStatus(status, command, actor)).toThrow();
      }
    }
    expect(isTerminal('CONFIRMED')).toBe(false);
  });

  it('enforces the actor, not just the state (customers cannot approve, providers cannot cancel for the customer)', () => {
    expect(() => nextStatus('REQUESTED', 'APPROVE', 'CUSTOMER')).toThrow(/may not/);
    expect(() => nextStatus('REQUESTED', 'EXPIRE', 'PROVIDER')).toThrow(/may not/);
    expect(() => nextStatus('REQUESTED', 'CUSTOMER_CANCEL', 'PROVIDER')).toThrow(/may not/);
    expect(() => nextStatus('SERVICE_COMPLETED', 'SETTLE', 'PROVIDER')).toThrow(/may not/); // a provider cannot self-settle
    expect(nextStatus('SERVICE_COMPLETED', 'SETTLE', 'CUSTOMER')).toBe('CLOSED'); // the customer may confirm early
  });
});

describe('arrival verification tokens', () => {
  const secret = randomBytes(32);
  const bookingId = '01a110ac-8dd0-79bb-9c7a-4bf53c70210c';
  const now = Date.UTC(2026, 9, 12, 5, 0, 0);

  it('derives a stable 6-digit PIN that depends on both the booking and the secret', () => {
    const pin = derivePin(secret, bookingId);
    expect(pin).toMatch(/^\d{6}$/);
    expect(derivePin(secret, bookingId)).toBe(pin);
    expect(derivePin(secret, '01a110ac-8dd0-79bb-9c7a-4bf53c702100')).not.toBe(pin);
    expect(derivePin(randomBytes(32), bookingId)).not.toBe(pin);
  });

  it('accepts only the exact PIN', () => {
    const pin = derivePin(secret, bookingId);
    expect(pinMatches(secret, bookingId, pin)).toBe(true);
    expect(pinMatches(secret, bookingId, pin === '000000' ? '000001' : '000000')).toBe(false);
    expect(pinMatches(secret, bookingId, '12345')).toBe(false);
    expect(pinMatches(secret, bookingId, 'abcdef')).toBe(false);
  });

  it('PINs are well spread (no obvious bias across many bookings)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(derivePin(secret, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    expect(seen.size).toBeGreaterThan(1900);
  });

  it('issues a signed, expiring QR token that names the booking and contains no personal data', () => {
    const { token, expiresAt } = issueQrToken(secret, bookingId, now);
    expect(token).toMatch(/^v1\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBe(now + QR_TTL_SECONDS * 1000);
    expect(verifyQrToken(secret, token, now + 1000)).toBe(bookingId);
  });

  it('rejects expired, forged, tampered and malformed tokens', () => {
    const { token } = issueQrToken(secret, bookingId, now);
    expect(verifyQrToken(secret, token, now + (QR_TTL_SECONDS + 1) * 1000)).toBeNull(); // expired
    expect(verifyQrToken(randomBytes(32), token, now)).toBeNull(); // other secret
    const [v, id, exp, mac] = token.split('.') as [string, string, string, string];
    expect(verifyQrToken(secret, `${v}.${id}.${Number(exp) + 600}.${mac}`, now)).toBeNull(); // extended expiry
    expect(verifyQrToken(secret, `${v}.00000000-0000-4000-8000-000000000000.${exp}.${mac}`, now)).toBeNull(); // other booking
    expect(verifyQrToken(secret, `${v}.${id}.${exp}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, now)).toBeNull(); // flipped signature
    for (const junk of ['', 'v1', 'v2.x.y.z', 'not a token', `${token}x`]) expect(verifyQrToken(secret, junk, now)).toBeNull();
  });
});
