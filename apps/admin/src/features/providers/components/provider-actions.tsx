'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff, useCan } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, type ReasonSpec } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { isStaleProblem, toAction } from '@/lib/client/actions';
import type { ActionResult } from '@/lib/problem';
import { ACTIONS_BY_STATUS, type Provider, type ProviderAction } from '../types';

interface ActionSpec {
  label: string;
  variant: 'primary' | 'danger' | 'secondary' | 'outline-danger';
  permission: 'provider:verify' | 'provider:suspend';
  title: string;
  description: (name: string) => string;
  effects: string[];
  reason?: ReasonSpec;
  success: string;
}

const REASON: ReasonSpec = { min: 5, max: 1000, placeholder: 'What did you find? This is recorded in the audit log.' };

const SPECS: Record<ProviderAction, ActionSpec> = {
  'start-review': {
    label: 'Start review',
    variant: 'secondary',
    permission: 'provider:verify',
    title: 'Start reviewing this provider?',
    description: (n) => `You are taking ${n} into review.`,
    effects: ['The status changes from SUBMITTED to UNDER REVIEW.', 'The provider is still not bookable until someone approves them.', 'The API does not take a reason for this step; the action is audited under your account.'],
    success: 'Review started.',
  },
  approve: {
    label: 'Approve',
    variant: 'primary',
    permission: 'provider:verify',
    title: 'Approve this provider?',
    description: (n) => `You are approving ${n}.`,
    effects: ['The provider becomes APPROVED and bookable: customers can find them and request bookings.', 'Payouts to this provider become possible once they have a verified bank account.', 'The API does not take a reason for approvals; the approval is audited under your account.'],
    success: 'Provider approved.',
  },
  reject: {
    label: 'Reject',
    variant: 'outline-danger',
    permission: 'provider:verify',
    title: 'Reject this application?',
    description: (n) => `You are rejecting ${n}.`,
    effects: ['The status changes to REJECTED and the provider is not bookable.', 'Your reason is shown to the provider so they can fix the problems and submit again.'],
    reason: { ...REASON, label: 'Reason for rejection', help: '5–1000 characters. The provider will see this.' },
    success: 'Application rejected.',
  },
  suspend: {
    label: 'Suspend',
    variant: 'outline-danger',
    permission: 'provider:suspend',
    title: 'Suspend this provider?',
    description: (n) => `You are suspending ${n}, who is currently approved.`,
    effects: ['The provider stops being bookable.', 'No new payouts are created for a provider who is not approved.', 'Bookings that already exist are NOT cancelled by this action; review them separately.'],
    reason: { ...REASON, label: 'Reason for suspension' },
    success: 'Provider suspended.',
  },
  reinstate: {
    label: 'Reinstate',
    variant: 'primary',
    permission: 'provider:suspend',
    title: 'Reinstate this provider?',
    description: (n) => `You are reinstating ${n}.`,
    effects: ['The status returns to APPROVED and the provider is bookable again.', 'The API does not take a reason for reinstatement; the action is audited under your account.'],
    success: 'Provider reinstated.',
  },
};

export function ProviderActions({ provider }: { provider: Provider }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState<ProviderAction | null>(null);

  const possible = ACTIONS_BY_STATUS[provider.status];
  const allowed = possible.filter((a) => can(SPECS[a].permission));
  const spec = open ? SPECS[open] : null;

  async function run(action: ProviderAction, reason: string): Promise<ActionResult> {
    const s = SPECS[action];
    const res = await bff.post(`/admin/providers/${provider.id}/${action}`, s.reason ? { reason } : undefined);
    if (res.ok || isStaleProblem(res.problem.code)) router.refresh();
    return toAction(res, s.success);
  }

  if (possible.length === 0) {
    return <p className="text-sm text-fg-muted">No verification action is available while the provider is {provider.status === 'DRAFT' ? 'a draft (they have not submitted yet)' : 'rejected (they must fix and resubmit)'}.</p>;
  }
  if (allowed.length === 0) {
    return <Alert tone="info">Actions are available for this status, but your role does not include the permission to perform them.</Alert>;
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {allowed.map((a) => (
          <Button key={a} variant={SPECS[a].variant} onClick={() => setOpen(a)}>
            {SPECS[a].label}
          </Button>
        ))}
      </div>
      {open && spec ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(null)}
          title={spec.title}
          description={spec.description(provider.display_name)}
          effects={spec.effects}
          confirmLabel={spec.label}
          tone={open === 'reject' || open === 'suspend' ? 'danger' : 'primary'}
          reason={spec.reason}
          onConfirm={({ reason }) => run(open, reason)}
        />
      ) : null}
    </>
  );
}
