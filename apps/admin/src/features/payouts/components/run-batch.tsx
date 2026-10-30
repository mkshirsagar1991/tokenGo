'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff, useCan } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { toAction } from '@/lib/client/actions';
import type { ActionResult } from '@/lib/problem';
import { SKIP_REASONS, type BatchResult } from '../types';

/** The summary shown after a run: what was created, and — in words — why each other provider was skipped. */
export function BatchSummary({ result }: { result: BatchResult }) {
  const skipped = Object.entries(result.batch.skipped).filter(([, n]) => (n ?? 0) > 0);
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-surface-2 p-3 text-center">
          <dt className="text-xs text-fg-subtle">Payouts created</dt>
          <dd className="text-xl font-semibold tabular-nums text-fg">{result.batch.payouts}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 p-3 text-center">
          <dt className="text-xs text-fg-subtle">Providers considered</dt>
          <dd className="text-xl font-semibold tabular-nums text-fg">{result.batch.considered}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 p-3 text-center">
          <dt className="text-xs text-fg-subtle">Stuck payouts re-driven</dt>
          <dd className="text-xl font-semibold tabular-nums text-fg">{result.sweep.payouts}</dd>
        </div>
      </dl>
      {skipped.length > 0 ? (
        <div>
          <p className="mb-1 font-medium text-fg">Skipped providers, by reason</p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {skipped.map(([reason, n]) => (
              <li key={reason} className="flex items-start justify-between gap-3 px-3 py-2">
                <span>
                  <code className="font-mono text-xs text-fg-subtle">{reason}</code>
                  <span className="block text-fg-muted">{SKIP_REASONS[reason] ?? 'See the API documentation for this reason.'}</span>
                </span>
                <span className="font-semibold tabular-nums text-fg">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-fg-muted">No provider was skipped.</p>
      )}
      {result.sweep.accounts > 0 ? <p className="text-fg-muted">{result.sweep.accounts} pending bank account check(s) were run.</p> : null}
    </div>
  );
}

export function RunBatchButton() {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  if (!can('payout:operate')) return null;

  async function run(): Promise<ActionResult> {
    const res = await bff.post<BatchResult>('/admin/payouts/run');
    if (res.ok) {
      setResult(res.data);
      router.refresh();
    }
    return toAction(res, 'Payout batch finished.');
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Run payout batch
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => {
            setOpen(false);
            setResult(null);
          }}
          title="Run a payout batch now?"
          description="This does what the worker does every few minutes: create payouts for every provider who is due, then re-drive anything that is stuck."
          effects={[
            'For each eligible provider, money moves from “payable” to “in transit” on the ledger and a bank transfer is requested from the payout provider.',
            'Only approved, unfrozen providers with a verified, cooled-off bank account and at least the minimum owed are paid; everyone else is skipped and listed afterwards.',
            'It is safe to repeat: a provider with a payout already in flight is skipped, and every transfer carries our own reference so a retry cannot pay twice.',
          ]}
          resultTitle="Payout batch finished"
          confirmLabel="Run batch"
          tone="primary"
          onConfirm={run}
          renderResult={() => (result ? <BatchSummary result={result} /> : <Alert tone="info">Finished.</Alert>)}
        />
      ) : null}
    </>
  );
}
