'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff, useCan } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/ui/form';
import { isStaleProblem, toAction } from '@/lib/client/actions';
import { istLocalToIso, isUuid } from '@/lib/format';
import { formatBps, formatMoney, parsePercentToBps, parseRupeesToMinor } from '@/lib/money';
import { describeRate } from '../format';
import { latestForScope } from '../versioning';
import type { CommissionRule, CommissionScope, ScopeOptions } from '../types';
import { EffectiveFields, ScopeFields, scheduleError, type EffectiveMode, type ScopeValue } from './version-fields';

const SCOPES: readonly CommissionScope[] = ['PLATFORM', 'CATEGORY', 'SERVICE_TYPE', 'PROVIDER', 'PROVIDER_SERVICE'];

/** "New version" for one scope (or any scope when `initial` is omitted). Creating a version never edits the old one. */
export function NewCommissionVersionButton({ options, initial, existing, label = 'New version' }: { options: ScopeOptions; initial?: ScopeValue; /** Every known version, so the dialog can say which one a new version replaces. */ existing: CommissionRule[]; label?: string }) {
  const router = useRouter();
  const bff = useBff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ScopeValue>(initial ?? { type: 'PLATFORM', id: '' });
  const [kind, setKind] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<EffectiveMode>('now');
  const [local, setLocal] = useState('');
  if (!can('pricing:manage')) return null;

  const scopeOk = scope.type === 'PLATFORM' || isUuid(scope.id);
  const parsed = kind === 'PERCENT' ? parsePercentToBps(value) : parseRupeesToMinor(value, { allowZero: true });
  const valueError = value.trim() !== '' && !parsed.ok ? parsed.error : undefined;
  const sErr = scheduleError(mode, local);
  const valid = scopeOk && parsed.ok && !sErr;
  const rate = parsed.ok ? (kind === 'PERCENT' ? formatBps(parsed.value) : `${formatMoney({ amount_minor: parsed.value, currency: 'INR' })} per booking`) : null;
  const current = latestForScope(existing, scope);
  const nextVersion = (current?.version ?? 0) + 1;

  function openDialog() {
    setScope(initial ?? { type: 'PLATFORM', id: '' });
    setKind(latestForScope(existing, initial ?? { type: 'PLATFORM', id: '' })?.kind ?? 'PERCENT');
    setValue('');
    setMode('now');
    setLocal('');
    setOpen(true);
  }

  return (
    <>
      <Button variant="secondary" size={initial ? 'sm' : 'md'} onClick={openDialog}>
        {label}
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title="New commission rule version"
          description="Commission is what the platform keeps from each completed booking. A change creates the next version; the old one is closed, never edited."
          effects={[
            current ? `Version ${nextVersion} replaces version ${current.version} (${describeRate(current)}) from the effective time; version ${current.version} is closed at that moment and stays in the history.` : 'This becomes version 1 for this scope.',
            'Bookings already requested keep the rate that applied when they were requested (a snapshot is stored with each booking). Bookings requested from the effective time use the new rate.',
            'The effective time cannot be in the past. Every change is audited. There is no second-person approval yet, so double-check the figure.',
          ]}
          confirmLabel={rate ? `Create version ${nextVersion}: ${rate}` : 'Create version'}
          canConfirm={valid}
          onConfirm={async () => {
            const body: Record<string, unknown> = { scope_type: scope.type, kind };
            if (scope.type !== 'PLATFORM') body.scope_id = scope.id;
            if (kind === 'PERCENT') body.percent_bps = parsed.ok ? parsed.value : undefined;
            else body.fixed_minor = parsed.ok ? parsed.value : undefined;
            if (mode === 'scheduled') body.effective_from = istLocalToIso(local);
            const res = await bff.post('/admin/commission-rules', body);
            if (res.ok || isStaleProblem(res.problem.code) || res.problem.code === 'RULE_VERSION_CONFLICT') router.refresh();
            return toAction(res, 'New commission version created.');
          }}
        >
          <div className="grid gap-4">
            <ScopeFields types={SCOPES} value={scope} onChange={setScope} options={options} />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Type" value={kind} onChange={(e) => { setKind(e.target.value as 'PERCENT' | 'FIXED'); setValue(''); }} options={[{ value: 'PERCENT', label: 'Percentage of the booking' }, { value: 'FIXED', label: 'Fixed amount per booking' }]} />
              <TextField label={kind === 'PERCENT' ? 'Percentage' : 'Amount in rupees'} value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" required placeholder={kind === 'PERCENT' ? 'e.g. 12.5' : 'e.g. 20'} error={valueError} hint={kind === 'PERCENT' ? '0–100, up to two decimals.' : 'Whole paise only (two decimals at most).'} />
            </div>
            <EffectiveFields mode={mode} local={local} onMode={setMode} onLocal={setLocal} error={sErr && local ? sErr : undefined} />
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
