'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/form';
import { toAction } from '@/lib/client/actions';
import { isoToIstLocal, istLocalToIso } from '@/lib/format';

const DAY = 86_400_000;

/**
 * Runs a reconciliation (payments or payouts) for a period in IST. It compares our records with the provider's and REPORTS
 * differences; it never repairs anything. The result is stored by the API and opened via ?run=<id>.
 */
export function RunReconciliationButton({ endpoint, subject, basePath, maxDays = 31 }: { endpoint: string; subject: 'payments' | 'payouts'; basePath: string; maxDays?: number }) {
  const router = useRouter();
  const bff = useBff();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function openDialog() {
    const now = Date.now();
    setTo(isoToIstLocal(new Date(now)));
    setFrom(isoToIstLocal(new Date(now - 7 * DAY)));
    setOpen(true);
  }

  const fromIso = istLocalToIso(from);
  const toIso = istLocalToIso(to);
  let error: string | undefined;
  if (fromIso && toIso) {
    const span = Date.parse(toIso) - Date.parse(fromIso);
    if (span <= 0) error = 'The end must be after the start.';
    else if (span > maxDays * DAY) error = `Choose a period of at most ${maxDays} days.`;
  }
  const valid = Boolean(fromIso && toIso) && !error;

  return (
    <>
      <Button variant="primary" onClick={openDialog}>
        Run reconciliation
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title={`Reconcile ${subject}`}
          description={`Compares our ${subject} for the period with what the ${subject === 'payments' ? 'payment' : 'payout'} provider reports.`}
          effects={['It only reports differences; it never repairs, credits or moves anything.', 'The run and its exceptions are stored so you can reopen them by link, and the run is audited.', `Times are in Indian Standard Time. Maximum period: ${maxDays} days.`]}
          confirmLabel="Run reconciliation"
          canConfirm={valid}
          onConfirm={async () => {
            const res = await bff.post<{ id: string }>(endpoint, { from: fromIso, to: toIso });
            if (res.ok) {
              router.push(`${basePath}?run=${res.data.id}`);
              router.refresh();
            }
            return toAction(res, 'Reconciliation finished.');
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="From (IST)" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
            <TextField label="To (IST)" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required error={error} />
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
