'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff, useCan } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { toAction } from '@/lib/client/actions';
import type { ActionResult } from '@/lib/problem';

const OUTCOME_TEXT: Record<string, string> = {
  SUBMITTED: 'The payout provider now has the transfer; it is waiting to be paid.',
  PAID: 'The payout provider says it is PAID. The ledger has been settled.',
  FAILED: 'The payout provider says it FAILED. The reservation was reversed and the money is payable again.',
  ALREADY_FINAL: 'This payout was already final; nothing changed.',
  NEEDS_REVIEW: 'The provider’s answer contradicts our records. Nothing was moved; the payout is flagged for review and the provider’s payouts are paused.',
  STILL_PENDING: 'The payout provider has not finished it yet. Try again later.',
};

export function RefreshPayoutButton({ payoutId, status }: { payoutId: string; status: string }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  if (!can('payout:operate') || (status !== 'RESERVED' && status !== 'SUBMITTED')) return null;

  async function run(): Promise<ActionResult> {
    const res = await bff.post<{ outcome: string }>(`/admin/payouts/${payoutId}/refresh`);
    if (res.ok) {
      setOutcome(res.data.outcome);
      router.refresh();
    }
    return toAction(res, 'Payout refreshed.');
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Refresh from payout provider
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => {
            setOpen(false);
            setOutcome(null);
          }}
          title="Ask the payout provider about this payout?"
          description="Re-checks the transfer with the payout provider using our own reference, and sends it only if the provider has never seen it."
          effects={['If the provider reports it paid or failed, the ledger is settled or reversed accordingly.', 'If its answer contradicts our records, nothing is moved: the payout is flagged for review and the provider’s payouts are paused.', 'Safe to repeat.']}
          resultTitle="Payout refreshed"
          confirmLabel="Refresh payout"
          onConfirm={run}
          renderResult={() => <Alert tone={outcome === 'NEEDS_REVIEW' || outcome === 'FAILED' ? 'warn' : 'success'} title={outcome ?? 'Done'}>{OUTCOME_TEXT[outcome ?? ''] ?? 'Done.'}</Alert>}
        />
      ) : null}
    </>
  );
}
