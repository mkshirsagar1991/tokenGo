/**
 * The payout-provider abstraction (requirements §19, §28; proposal §K P5). Payouts are bank transfers to providers.
 * The rule that shapes it: every operation is keyed by OUR reference (the payout id), so "I sent it and heard nothing" is
 * resolved by QUERYING that reference — never by sending again (critical test #7).
 */
export type BankVerificationStatus = 'VERIFIED' | 'FAILED' | 'PENDING';

export interface BankVerification {
  status: BankVerificationStatus;
  /** The account holder's name as registered at the bank (from a penny-drop style check), when the provider returns it. */
  nameAtBank?: string;
  failureReason?: string;
}

/** QUEUED/PROCESSING are not final. REVERSED = the bank returned the money (before OR after it was reported paid). */
export type ProviderPayoutStatus = 'QUEUED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REVERSED';

export interface ProviderPayout {
  provider: string;
  payoutId: string;
  /** Our reference, echoed back. */
  reference: string;
  amountMinor: bigint;
  currency: string;
  status: ProviderPayoutStatus;
  /** The bank's transaction reference once the money has moved. */
  utr?: string;
  failureReason?: string;
  createdAt: Date;
}

/** Plaintext bank details. Exists only in memory for the duration of one provider call; never logged, never stored in clear. */
export interface PayoutDestination {
  accountNumber: string;
  ifsc: string;
  holderName: string;
}

/** The provider DEFINITIVELY refused (e.g. beneficiary blocked). Unlike a timeout, this is safe to treat as "did not happen". */
export class PayoutRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PayoutRejectedError';
  }
}

export abstract class PayoutProvider {
  abstract readonly name: string;

  /** Idempotent by `reference`: asking again returns the same check, advancing it if it was still pending. */
  abstract verifyBankAccount(input: { reference: string; destination: PayoutDestination }): Promise<BankVerification>;

  /** Idempotent by `reference`: the same reference never produces a second transfer. */
  abstract createPayout(input: { reference: string; amountMinor: bigint; currency: string; destination: PayoutDestination }): Promise<ProviderPayout>;

  /** The query that makes retries safe. null = the provider has never seen this reference. */
  abstract fetchPayoutByReference(reference: string): Promise<ProviderPayout | null>;

  /** Every payout the provider created in [from, to) — the provider's side of reconciliation. */
  abstract listPayouts(range: { from: Date; to: Date }): Promise<ProviderPayout[]>;
}
