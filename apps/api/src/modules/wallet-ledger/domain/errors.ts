import { ConflictError, DomainError } from '../../../shared-kernel';

/** The customer's AVAILABLE balance cannot cover the amount (docs §12: never negative). */
export class InsufficientFundsError extends DomainError {
  constructor(availableMinor: bigint, requiredMinor: bigint, currency: string) {
    super('INSUFFICIENT_FUNDS', 'Your available wallet balance is not enough for this booking', 409, {
      available: { amount_minor: Number(availableMinor), currency },
      required: { amount_minor: Number(requiredMinor), currency },
      shortfall: { amount_minor: Number(requiredMinor - availableMinor), currency },
    });
  }
}

export class HoldAlreadyClosedError extends ConflictError {
  constructor(status: string) {
    super('HOLD_ALREADY_CLOSED', `The hold is already ${status}`, { status });
  }
}

/** A bug-level condition (unbalanced posting, unknown account...). Never shown in detail to clients. */
export class LedgerInvariantError extends DomainError {
  constructor(message: string) {
    super('LEDGER_INVARIANT_VIOLATION', message, 500);
  }
}
