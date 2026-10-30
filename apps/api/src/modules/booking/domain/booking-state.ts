import { ConflictError } from '../../../shared-kernel';

/**
 * The booking lifecycle (requirements §15). Status is NEVER set through a generic update — the only way to
 * move is a named command listed here. Payment/funds and settlement are separate dimensions on the booking.
 *
 * DRAFT / PAYMENT_PENDING / PAYMENT_HELD are reserved for a per-booking-payment model (proposal G3); the
 * wallet model creates bookings directly in REQUESTED, atomically with the funds hold.
 */
export type BookingStatus =
  | 'DRAFT'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_HELD'
  | 'REQUESTED'
  | 'CONFIRMED'
  | 'PROVIDER_REJECTED'
  | 'EXPIRED'
  | 'CUSTOMER_CANCELLED'
  | 'PROVIDER_CANCELLED'
  | 'NO_SHOW'
  | 'CUSTOMER_ARRIVED'
  | 'SERVICE_STARTED'
  | 'SERVICE_COMPLETED'
  | 'DISPUTED'
  | 'CLOSED';

export type BookingCommand =
  | 'APPROVE'
  | 'REJECT'
  | 'EXPIRE'
  | 'CUSTOMER_CANCEL'
  | 'PROVIDER_CANCEL'
  | 'MARK_NO_SHOW'
  | 'VERIFY_ARRIVAL'
  | 'START'
  | 'COMPLETE'
  | 'SETTLE'
  | 'DISPUTE'
  | 'RESOLVE_DISPUTE';

export type ActorKind = 'CUSTOMER' | 'PROVIDER' | 'ADMIN' | 'SYSTEM';

interface Transition {
  from: readonly BookingStatus[];
  to: BookingStatus;
  actors: readonly ActorKind[];
}

export const TRANSITIONS: Record<BookingCommand, Transition> = {
  APPROVE: { from: ['REQUESTED'], to: 'CONFIRMED', actors: ['PROVIDER'] },
  REJECT: { from: ['REQUESTED'], to: 'PROVIDER_REJECTED', actors: ['PROVIDER'] },
  EXPIRE: { from: ['REQUESTED'], to: 'EXPIRED', actors: ['SYSTEM'] },
  CUSTOMER_CANCEL: { from: ['REQUESTED', 'CONFIRMED'], to: 'CUSTOMER_CANCELLED', actors: ['CUSTOMER'] },
  PROVIDER_CANCEL: { from: ['CONFIRMED'], to: 'PROVIDER_CANCELLED', actors: ['PROVIDER', 'ADMIN'] },
  MARK_NO_SHOW: { from: ['CONFIRMED'], to: 'NO_SHOW', actors: ['PROVIDER'] },
  VERIFY_ARRIVAL: { from: ['CONFIRMED'], to: 'CUSTOMER_ARRIVED', actors: ['PROVIDER'] },
  START: { from: ['CUSTOMER_ARRIVED'], to: 'SERVICE_STARTED', actors: ['PROVIDER'] },
  COMPLETE: { from: ['SERVICE_STARTED'], to: 'SERVICE_COMPLETED', actors: ['PROVIDER'] },
  SETTLE: { from: ['SERVICE_COMPLETED'], to: 'CLOSED', actors: ['SYSTEM', 'CUSTOMER'] },
  // A customer who disputes a completed service freezes settlement; only an administrator's decision closes it (requirements §20).
  DISPUTE: { from: ['SERVICE_COMPLETED'], to: 'DISPUTED', actors: ['CUSTOMER'] },
  RESOLVE_DISPUTE: { from: ['DISPUTED'], to: 'CLOSED', actors: ['ADMIN'] },
};

/** The booking can no longer change (everything else may still move). */
export const TERMINAL: readonly BookingStatus[] = ['PROVIDER_REJECTED', 'EXPIRED', 'CUSTOMER_CANCELLED', 'PROVIDER_CANCELLED', 'NO_SHOW', 'CLOSED'];

export function isTerminal(status: BookingStatus): boolean {
  return TERMINAL.includes(status);
}

/** Validates source state AND actor; returns the target state. */
export function nextStatus(current: BookingStatus, command: BookingCommand, actor: ActorKind): BookingStatus {
  const t = TRANSITIONS[command];
  if (!t.from.includes(current)) {
    throw new ConflictError('INVALID_STATE_TRANSITION', `Cannot ${command.toLowerCase().replace(/_/g, ' ')} a booking that is ${current}`, { from: current, command });
  }
  if (!t.actors.includes(actor)) {
    throw new ConflictError('INVALID_STATE_TRANSITION', `${actor} may not perform ${command}`, { command, actor });
  }
  return t.to;
}
