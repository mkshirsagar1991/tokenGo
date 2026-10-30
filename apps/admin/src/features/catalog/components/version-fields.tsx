'use client';

import { SelectField, TextField } from '@/components/ui/form';
import { formatDateTime, isUuid, istLocalToIso } from '@/lib/format';
import type { ScopeOptions } from '../types';

export interface ScopeValue {
  type: string;
  id: string;
}

/** Scope selector shared by the commission and cancellation forms. PLATFORM needs no id; the others need the id of what they apply to. */
export function ScopeFields({ types, value, onChange, options, error }: { types: readonly string[]; value: ScopeValue; onChange: (v: ScopeValue) => void; options: ScopeOptions; error?: string }) {
  const needsId = value.type !== 'PLATFORM';
  const list = value.type === 'CATEGORY' ? options.categories : value.type === 'PROVIDER' ? options.providers : null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField label="Applies to" value={value.type} onChange={(e) => onChange({ type: e.target.value, id: '' })} options={types.map((t) => ({ value: t, label: t === 'PLATFORM' ? 'Whole platform (default)' : t === 'PROVIDER_SERVICE' ? 'One provider service' : t === 'SERVICE_TYPE' ? 'A service type' : t === 'PROVIDER' ? 'One provider' : 'One category' }))} hint="A more specific scope overrides a broader one." />
      {needsId ? (
        list && list.length > 0 ? (
          <SelectField label={value.type === 'CATEGORY' ? 'Category' : 'Provider'} value={value.id} onChange={(e) => onChange({ ...value, id: e.target.value })} placeholder="Choose…" options={list} required error={error} />
        ) : (
          <TextField label={`${value.type === 'SERVICE_TYPE' ? 'Service type' : value.type === 'PROVIDER_SERVICE' ? 'Provider service' : value.type === 'PROVIDER' ? 'Provider' : 'Category'} id`} value={value.id} onChange={(e) => onChange({ ...value, id: e.target.value.trim() })} placeholder="UUID" spellCheck={false} className="font-mono text-xs" required error={error ?? (value.id && !isUuid(value.id) ? 'Enter a valid UUID.' : undefined)} />
        )
      ) : null}
    </div>
  );
}

export type EffectiveMode = 'now' | 'scheduled';

export function EffectiveFields({ mode, local, onMode, onLocal, error }: { mode: EffectiveMode; local: string; onMode: (m: EffectiveMode) => void; onLocal: (v: string) => void; error?: string }) {
  const iso = mode === 'scheduled' ? istLocalToIso(local) : null;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium text-fg">When it takes effect</legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="effective" checked={mode === 'now'} onChange={() => onMode('now')} className="accent-[var(--brand)]" /> Immediately (from the moment you confirm)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="effective" checked={mode === 'scheduled'} onChange={() => onMode('scheduled')} className="accent-[var(--brand)]" /> At a future time
      </label>
      {mode === 'scheduled' ? <TextField label="Effective from (IST)" type="datetime-local" value={local} onChange={(e) => onLocal(e.target.value)} required error={error} hint={iso ? `Starts ${formatDateTime(iso)}. It cannot be in the past: history is never rewritten.` : 'It cannot be in the past: history is never rewritten.'} /> : null}
    </fieldset>
  );
}

/** Returns an error message for a scheduled time that is invalid or not in the future; undefined when fine. */
export function scheduleError(mode: EffectiveMode, local: string, now: number = Date.now()): string | undefined {
  if (mode !== 'scheduled') return undefined;
  const iso = istLocalToIso(local);
  if (!iso) return 'Choose a date and time.';
  if (Date.parse(iso) < now + 5_000) return 'Choose a time in the future.';
  return undefined;
}
