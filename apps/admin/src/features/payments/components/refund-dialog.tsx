'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useBff, useCan } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, Spinner } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/form';
import { newIdempotencyKey, toAction } from '@/lib/client/actions';
import { shortId } from '@/lib/format';
import { formatMoney, parseRupeesToMinor, sumMinor } from '@/lib/money';
import type { PageMeta } from '@/lib/api-types';
import type { ActionResult } from '@/lib/problem';
import type { PaymentTransaction, Refund } from '../types';

/** refundable = payment amount − every refund of it that has not FAILED (the same rule the API enforces). */
export function refundableMinor(paymentMinor: number, refunds: Array<Pick<Refund, 'status' | 'amount'>>): bigint {
  const taken = sumMinor(refunds.filter((r) => r.status !== 'FAILED').map((r) => r.amount.amount_minor));
  const left = BigInt(paymentMinor) - taken;
  return left > 0n ? left : 0n;
}

export function validateRefundAmount(input: string, refundable: bigint): { ok: true; minor: number } | { ok: false; error: string } {
  const parsed = parseRupeesToMinor(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (BigInt(parsed.value) > refundable) return { ok: false, error: `That is more than the ${formatMoney({ amount_minor: Number(refundable), currency: 'INR' })} that can still be refunded.` };
  return { ok: true, minor: parsed.value };
}

export function RefundButton({ tx }: { tx: PaymentTransaction }) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (tx.status !== 'CAPTURED' || !can('refund:create')) return null;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Refund…
      </Button>
      {open ? <RefundDialog tx={tx} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function RefundDialog({ tx, onClose }: { tx: PaymentTransaction; onClose: () => void }) {
  const router = useRouter();
  const bff = useBff();
  // One idempotency key per opening of the dialog = one intent. A double click or a retry after a lost response replays, never duplicates.
  const [key] = useState(() => newIdempotencyKey('refund'));
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; refunds: Refund[] } | { kind: 'error'; message: string }>({ kind: 'loading' });
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [amount, setAmount] = useState('');
  const [created, setCreated] = useState<Refund | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bff.get<Refund[], PageMeta>('/admin/payments/refunds', { payment_transaction_id: tx.id, limit: '100' }).then((r) => {
      if (cancelled) return;
      setState(r.ok ? { kind: 'ready', refunds: r.data } : { kind: 'error', message: r.problem.detail });
    });
    return () => {
      cancelled = true;
    };
  }, [bff, tx.id]);

  const refundable = useMemo(() => (state.kind === 'ready' ? refundableMinor(tx.amount.amount_minor, state.refunds) : 0n), [state, tx.amount.amount_minor]);
  const refunded = BigInt(tx.amount.amount_minor) - refundable;
  const partial = mode === 'partial' ? validateRefundAmount(amount, refundable) : null;
  const toRefund: number | null = state.kind !== 'ready' ? null : mode === 'full' ? (refundable > 0n ? Number(refundable) : null) : partial?.ok ? partial.minor : null;
  const amountError = mode === 'partial' && amount.trim() !== '' && partial && !partial.ok ? partial.error : undefined;
  const money = (minor: number | bigint) => formatMoney({ amount_minor: Number(minor), currency: tx.amount.currency });

  async function run(reason: string): Promise<ActionResult> {
    if (toRefund === null) return { ok: false, problem: { status: 422, code: 'VALIDATION_FAILED', detail: 'Choose a valid amount.' } };
    const res = await bff.post<Refund>('/admin/payments/refunds', { payment_transaction_id: tx.id, amount_minor: toRefund, reason }, { idempotencyKey: key });
    if (res.ok) {
      setCreated(res.data);
      router.refresh();
    }
    return toAction(res, 'Refund requested.');
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Refund to the customer's original payment method"
      description={`Payment ${tx.provider_payment_id ?? shortId(tx.id)} · ${money(tx.amount.amount_minor)} captured via ${tx.provider}`}
      effects={
        toRefund !== null
          ? [
              `${money(toRefund)} leaves the customer's wallet immediately and is sent back to their original payment method through ${tx.provider}.`,
              'If the provider refuses it, the money returns to the wallet automatically. A refund that the provider accepts cannot be undone from here.',
              'The refund, your reason and your account are recorded in the audit log.',
            ]
          : ['Choose how much to refund. The amount can never exceed what remains refundable on the payment.']
      }
      resultTitle="Refund requested"
      confirmLabel={toRefund !== null ? `Refund ${money(toRefund)}` : 'Refund'}
      tone="danger"
      reason={{ min: 3, max: 500, placeholder: 'Why is this refund being issued?', help: '3–500 characters. Sent to the API and audited.' }}
      canConfirm={state.kind === 'ready' && toRefund !== null && toRefund > 0}
      onConfirm={({ reason }) => run(reason)}
      renderResult={() =>
        created ? (
          <Alert tone="success" title={`Refund ${created.status === 'PROCESSING' ? 'is being processed' : created.status.toLowerCase()}`}>
            {money(created.amount.amount_minor)} · <Link className="underline" href={`/payments/refunds/${created.id}`}>View refund</Link>
          </Alert>
        ) : null
      }
    >
      {state.kind === 'loading' ? <Spinner label="Checking what has already been refunded…" /> : null}
      {state.kind === 'error' ? <Alert tone="danger">Could not load existing refunds for this payment: {state.message}</Alert> : null}
      {state.kind === 'ready' ? (
        <>
          <dl className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-lg bg-surface-2 p-2">
              <dt className="text-xs text-fg-subtle">Payment</dt>
              <dd className="font-semibold tabular-nums">{money(tx.amount.amount_minor)}</dd>
            </div>
            <div className="rounded-lg bg-surface-2 p-2">
              <dt className="text-xs text-fg-subtle">Already refunded</dt>
              <dd className="font-semibold tabular-nums">{money(refunded)}</dd>
            </div>
            <div className="rounded-lg bg-surface-2 p-2">
              <dt className="text-xs text-fg-subtle">Can still refund</dt>
              <dd className="font-semibold tabular-nums">{money(refundable)}</dd>
            </div>
          </dl>
          {refundable === 0n ? (
            <Alert tone="warn">Nothing is left to refund on this payment.</Alert>
          ) : (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium text-fg">Amount</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="mode" checked={mode === 'full'} onChange={() => setMode('full')} className="accent-[var(--brand)]" /> Refund everything that remains ({money(refundable)})
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="mode" checked={mode === 'partial'} onChange={() => setMode('partial')} className="accent-[var(--brand)]" /> Refund part of it
              </label>
              {mode === 'partial' ? <TextField label="Amount in rupees" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 250 or 99.50" error={amountError} hint={`At most ${money(refundable)}, two decimals at most.`} autoFocus /> : null}
            </fieldset>
          )}
        </>
      ) : null}
    </ConfirmDialog>
  );
}
