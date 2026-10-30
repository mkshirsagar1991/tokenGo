'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff, useCan } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/form';
import { isStaleProblem, toAction } from '@/lib/client/actions';
import { isUuid, istLocalToIso } from '@/lib/format';
import { formatBps, parsePercentToBps } from '@/lib/money';
import { latestForScope, validateTiers, type Tier } from '../versioning';
import type { CancellationPolicy, ScopeOptions } from '../types';
import { EffectiveFields, ScopeFields, scheduleError, type EffectiveMode, type ScopeValue } from './version-fields';

interface TierRow {
  hours: string;
  percent: string;
}

const DEFAULT_TIERS: TierRow[] = [
  { hours: '24', percent: '100' },
  { hours: '4', percent: '50' },
  { hours: '0', percent: '0' },
];

const intHours = (s: string): number | null => (/^\d{1,4}$/.test(s.trim()) ? Number(s.trim()) : null);

/** Plain-language preview of the tiers, so an operator can read back what customers will experience. */
export function tierSentences(tiers: Tier[]): string[] {
  const sorted = [...tiers].sort((a, b) => b.hours - a.hours);
  return sorted.map((t, i) => {
    const refund = formatBps(t.refundBps);
    if (t.hours === 0) {
      const prev = sorted[i - 1];
      return prev ? `Less than ${prev.hours} hour${prev.hours === 1 ? '' : 's'} before the start: ${refund} refunded` : `Any time: ${refund} refunded`;
    }
    return `${t.hours} hour${t.hours === 1 ? '' : 's'} or more before the start: ${refund} refunded`;
  });
}

export function NewCancellationVersionButton({ options, initial, existing, label = 'New version' }: { options: ScopeOptions; initial?: ScopeValue; /** Every known version, so the dialog can say which one a new version replaces. */ existing: CancellationPolicy[]; label?: string }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ScopeValue>(initial ?? { type: 'PLATFORM', id: '' });
  const [name, setName] = useState('');
  const [rows, setRows] = useState<TierRow[]>(DEFAULT_TIERS);
  const [noShow, setNoShow] = useState('0');
  const [providerCancel, setProviderCancel] = useState('100');
  const [mode, setMode] = useState<EffectiveMode>('now');
  const [local, setLocal] = useState('');
  if (!can('pricing:manage')) return null;

  const scopeOk = scope.type === 'PLATFORM' || isUuid(scope.id);
  const parsedTiers = rows.map((r) => ({ hours: intHours(r.hours), pct: parsePercentToBps(r.percent) }));
  const tiersParsed = parsedTiers.every((t) => t.hours !== null && t.pct.ok);
  const tiers: Tier[] = tiersParsed ? parsedTiers.map((t) => ({ hours: t.hours as number, refundBps: t.pct.ok ? t.pct.value : 0 })) : [];
  const tierProblems = tiersParsed ? validateTiers(tiers) : ['Every tier needs whole hours and a percentage between 0 and 100.'];
  const ns = parsePercentToBps(noShow);
  const pc = parsePercentToBps(providerCancel);
  const nameOk = name.trim().length >= 1 && name.trim().length <= 100;
  const sErr = scheduleError(mode, local);
  const valid = scopeOk && nameOk && tierProblems.length === 0 && ns.ok && pc.ok && !sErr;
  const current = latestForScope(existing, scope);
  const nextVersion = (current?.version ?? 0) + 1;

  function openDialog() {
    setScope(initial ?? { type: 'PLATFORM', id: '' });
    const start = latestForScope(existing, initial ?? { type: 'PLATFORM', id: '' });
    setName(start?.name ?? '');
    setRows(DEFAULT_TIERS);
    setNoShow(start ? String(start.no_show_refund_bps / 100) : '0');
    setProviderCancel(start ? String(start.provider_cancel_refund_bps / 100) : '100');
    setMode('now');
    setLocal('');
    setOpen(true);
  }

  const update = (i: number, patch: Partial<TierRow>) => setRows((cur) => cur.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  return (
    <>
      <Button variant="secondary" size={initial ? 'sm' : 'md'} onClick={openDialog}>
        {label}
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title="New cancellation policy version"
          description="Decides how much of a booking is refunded when a customer cancels, and for no-shows and provider cancellations. A change creates the next version; the old one is closed, never edited."
          effects={[
            current ? `Version ${nextVersion} replaces version ${current.version} from the effective time; version ${current.version} is closed at that moment and stays in the history.` : 'This becomes version 1 for this scope.',
            'Bookings already requested keep the policy that applied when they were requested. Bookings requested from the effective time use the new one.',
            'The effective time cannot be in the past. Every change is audited. There is no second-person approval yet.',
          ]}
          confirmLabel={`Create version ${nextVersion}`}
          canConfirm={valid}
          onConfirm={async () => {
            const body: Record<string, unknown> = {
              name: name.trim(),
              scope_type: scope.type,
              tiers: tiers.map((t) => ({ min_hours_before: t.hours, refund_bps: t.refundBps })),
              no_show_refund_bps: ns.ok ? ns.value : 0,
              provider_cancel_refund_bps: pc.ok ? pc.value : 10000,
            };
            if (scope.type !== 'PLATFORM') body.scope_id = scope.id;
            if (mode === 'scheduled') body.effective_from = istLocalToIso(local);
            const res = await bff.post('/admin/cancellation-policies', body);
            if (res.ok || isStaleProblem(res.problem.code) || res.problem.code === 'POLICY_VERSION_CONFLICT') router.refresh();
            return toAction(res, 'New cancellation policy version created.');
          }}
        >
          <div className="grid gap-4">
            <ScopeFields types={['PLATFORM', 'CATEGORY', 'PROVIDER']} value={scope} onChange={setScope} options={options} />
            <TextField label="Policy name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="e.g. Platform default" />

            <fieldset>
              <legend className="mb-1 text-sm font-medium text-fg">Refund by notice given</legend>
              <p className="mb-2 text-xs text-fg-subtle">The refund is the share of the booking amount returned to the customer. Each tier applies when they cancel at least that many hours before the start.</p>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                    <TextField label={i === 0 ? 'Hours before start' : <span className="sr-only">Hours before start</span>} aria-label={`Tier ${i + 1} hours before start`} inputMode="numeric" value={r.hours} onChange={(e) => update(i, { hours: e.target.value })} />
                    <TextField label={i === 0 ? 'Refund %' : <span className="sr-only">Refund percent</span>} aria-label={`Tier ${i + 1} refund percent`} inputMode="decimal" value={r.percent} onChange={(e) => update(i, { percent: e.target.value })} />
                    <Button variant="ghost" size="sm" aria-label={`Remove tier ${i + 1}`} disabled={rows.length <= 1} onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="mt-2" disabled={rows.length >= 10} onClick={() => setRows((cur) => [...cur, { hours: '', percent: '' }])}>
                + Add tier
              </Button>
              {tierProblems.length > 0 ? (
                <Alert tone="warn" className="mt-2">
                  <ul className="list-disc pl-4">
                    {tierProblems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Alert>
              ) : (
                <ul className="mt-2 list-disc space-y-0.5 rounded-lg bg-surface-2 py-2 pl-7 pr-3 text-sm text-fg-muted" aria-label="What customers will experience">
                  {tierSentences(tiers).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="No-show refund %" inputMode="decimal" value={noShow} onChange={(e) => setNoShow(e.target.value)} error={!ns.ok ? ns.error : undefined} hint="Share refunded when the customer does not turn up." />
              <TextField label="Provider-cancelled refund %" inputMode="decimal" value={providerCancel} onChange={(e) => setProviderCancel(e.target.value)} error={!pc.ok ? pc.error : undefined} hint="Share refunded when the provider cancels." />
            </div>
            <EffectiveFields mode={mode} local={local} onMode={setMode} onLocal={setLocal} error={sErr && local ? sErr : undefined} />
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
