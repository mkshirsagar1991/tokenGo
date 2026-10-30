import { ConflictError } from '../../../shared-kernel';

export type ProviderStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type ProviderAction = 'SUBMIT' | 'START_REVIEW' | 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REINSTATE';

/**
 * Provider verification lifecycle (requirements §6: providers must pass verification before accepting
 * bookings). Status is NEVER set through a generic update — only these named transitions exist.
 */
const TRANSITIONS: Record<ProviderAction, { from: readonly ProviderStatus[]; to: ProviderStatus }> = {
  SUBMIT: { from: ['DRAFT', 'REJECTED'], to: 'SUBMITTED' },
  START_REVIEW: { from: ['SUBMITTED'], to: 'UNDER_REVIEW' },
  APPROVE: { from: ['SUBMITTED', 'UNDER_REVIEW'], to: 'APPROVED' },
  REJECT: { from: ['SUBMITTED', 'UNDER_REVIEW'], to: 'REJECTED' },
  SUSPEND: { from: ['APPROVED'], to: 'SUSPENDED' },
  REINSTATE: { from: ['SUSPENDED'], to: 'APPROVED' },
};

export function nextProviderStatus(current: ProviderStatus, action: ProviderAction): ProviderStatus {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current)) {
    throw new ConflictError('INVALID_STATE_TRANSITION', `Cannot ${action.toLowerCase()} a provider that is ${current}`, {
      from: current,
      action,
    });
  }
  return rule.to;
}

/** Only an APPROVED provider may accept bookings (enforced again by the booking module later). */
export function isBookable(status: ProviderStatus): boolean {
  return status === 'APPROVED';
}
