'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff, useCan } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/form';
import { isStaleProblem, toAction } from '@/lib/client/actions';
import { isUuid } from '@/lib/format';
import type { ActionResult } from '@/lib/problem';

/** Freeze (reason required) or unfreeze a provider's payouts. Money-risk action: confirmation states exactly what changes. */
export function HoldControl({ providerId, providerName, frozen }: { providerId: string; providerName?: string; frozen: boolean }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (!can('payout:operate')) return null;
  const name = providerName ?? 'this provider';

  async function run(reason: string): Promise<ActionResult> {
    const res = frozen ? await bff.post(`/admin/payouts/providers/${providerId}/unfreeze`) : await bff.post(`/admin/payouts/providers/${providerId}/freeze`, { reason });
    if (res.ok || isStaleProblem(res.problem.code)) router.refresh();
    return toAction(res, frozen ? 'Payouts resumed.' : 'Payouts frozen.');
  }

  return (
    <>
      <Button variant={frozen ? 'primary' : 'outline-danger'} size="sm" onClick={() => setOpen(true)}>
        {frozen ? 'Unfreeze payouts' : 'Freeze payouts'}
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title={frozen ? 'Unfreeze payouts?' : 'Freeze payouts?'}
          description={frozen ? `Payouts for ${name} will be allowed again.` : `Money owed to ${name} will stop being paid out until someone unfreezes it.`}
          effects={
            frozen
              ? ['Removes the hold. If the hold was placed automatically after repeated failures, make sure the cause is fixed first.', 'The next payout run (automatic or manual) may create a payout for any eligible money.']
              : ['No new payout is created for this provider while frozen; money stays on the ledger as payable.', 'A payout already in flight is not stopped.', 'The freeze and your reason are recorded in the audit log.']
          }
          confirmLabel={frozen ? 'Unfreeze payouts' : 'Freeze payouts'}
          tone={frozen ? 'primary' : 'danger'}
          reason={frozen ? undefined : { min: 3, max: 300, placeholder: 'Why are payouts being frozen?' }}
          onConfirm={({ reason }) => run(reason)}
        />
      ) : null}
    </>
  );
}

/** Freeze a provider by id (used on the holds page, where there is no provider row to click). */
export function FreezeByIdButton() {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  if (!can('payout:operate')) return null;
  const valid = isUuid(id.trim());

  return (
    <>
      <Button variant="outline-danger" onClick={() => setOpen(true)}>
        Freeze a provider…
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title="Freeze a provider's payouts"
          description="Stops new payouts for one provider until someone unfreezes them."
          effects={['No new payout is created for this provider while frozen; a payout already in flight is not stopped.', 'The freeze and your reason are recorded in the audit log.']}
          confirmLabel="Freeze payouts"
          tone="danger"
          reason={{ min: 3, max: 300, placeholder: 'Why are payouts being frozen?' }}
          canConfirm={valid}
          onConfirm={async ({ reason }) => {
            const res = await bff.post(`/admin/payouts/providers/${id.trim()}/freeze`, { reason });
            if (res.ok) router.refresh();
            return toAction(res, 'Payouts frozen.');
          }}
        >
          <TextField label="Provider id" value={id} onChange={(e) => setId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoComplete="off" className="font-mono text-xs" error={id.trim() && !valid ? 'Enter the provider’s UUID (copy it from the provider page).' : undefined} />
        </ConfirmDialog>
      ) : null}
    </>
  );
}
