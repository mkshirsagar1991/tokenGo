export type ProviderStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export const PROVIDER_STATUSES: readonly ProviderStatus[] = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'];

export interface Provider {
  id: string;
  display_name: string;
  description: string | null;
  status: ProviderStatus;
  submitted_at: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  version: number;
  created_at: string;
}

export type ProviderAction = 'start-review' | 'approve' | 'reject' | 'suspend' | 'reinstate';

/** Which verification actions are possible from a status (mirrors the API's state machine; the API remains the authority). */
export const ACTIONS_BY_STATUS: Record<ProviderStatus, readonly ProviderAction[]> = {
  DRAFT: [],
  SUBMITTED: ['start-review', 'approve', 'reject'],
  UNDER_REVIEW: ['approve', 'reject'],
  APPROVED: ['suspend'],
  REJECTED: [],
  SUSPENDED: ['reinstate'],
};

export type { AuditEvent } from '@/features/audit/types';
