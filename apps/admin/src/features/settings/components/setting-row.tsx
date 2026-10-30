'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useBff } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/feedback';
import { Switch, TextField } from '@/components/ui/form';
import { IdChip } from '@/components/ui/id';
import { isStaleProblem, toAction } from '@/lib/client/actions';
import { formatDateTime } from '@/lib/format';
import { displayValue, draftFromValue, parseDraft, sameValue } from '../parse';
import type { SettingView } from '../types';

/** One setting: a typed editor, its default/constraints, who changed it last, and a confirmation that shows before → after. */
export function SettingRow({ setting }: { setting: SettingView }) {
  const router = useRouter();
  const bff = useBff();
  const [draft, setDraft] = useState<string | boolean>(draftFromValue(setting.kind, setting.value));
  const [open, setOpen] = useState(false);
  const inputId = `setting-${setting.key}`;

  const parsed = parseDraft(setting, draft);
  const dirty = parsed.ok && !sameValue(parsed.value, setting.value);
  const c = setting.constraints;
  const bounds =
    setting.kind === 'string' ? `Up to ${c.max_length} characters${c.hint ? `, ${c.hint}` : ''}.`
    : setting.kind === 'int' ? `Whole number from ${c.min} to ${c.max}.`
    : setting.kind === 'int_list' ? `${c.min_items}–${c.max_items} whole numbers (${c.min}–${c.max} each)${c.ascending ? ', increasing' : ''}, separated by commas.`
    : undefined;

  return (
    <div className="grid gap-3 border-b border-line p-4 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm text-fg">{setting.key}</code>
          {setting.customised ? <Badge tone="brand">Customised</Badge> : <Badge>Default</Badge>}
          {setting.public ? <Badge tone="warn" title="Readable without signing in, by the mobile apps (GET /app-config)">Public</Badge> : <Badge>Internal</Badge>}
        </div>
        <p className="mt-1 text-sm text-fg-muted">{setting.description}</p>
        <p className="mt-2 text-xs text-fg-subtle">
          Default: <span className="text-fg-muted">{displayValue(setting.key, setting.kind, setting.default)}</span>
          {setting.customised ? (
            <>
              {' · '}version {setting.version}, changed {formatDateTime(setting.updated_at)} by <IdChip id={setting.updated_by} label="user id" />
            </>
          ) : null}
        </p>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) setOpen(true);
        }}
      >
        {setting.kind === 'bool' ? (
          <label htmlFor={inputId} className="flex items-center gap-3 text-sm font-medium text-fg">
            <Switch id={inputId} checked={Boolean(draft)} onChange={setDraft} label={setting.key} />
            {draft ? 'On' : 'Off'}
          </label>
        ) : (
          <TextField
            id={inputId}
            label={<span className="sr-only">Value of {setting.key}</span>}
            value={String(draft)}
            onChange={(e) => setDraft(e.target.value)}
            error={!parsed.ok ? parsed.error : undefined}
            hint={bounds}
            inputMode={setting.kind === 'string' ? 'text' : 'numeric'}
            className={setting.kind === 'string' ? undefined : 'font-mono'}
            spellCheck={false}
          />
        )}
        {parsed.ok && setting.key.endsWith('_minor') && dirty ? <p className="text-xs text-fg-subtle">= {displayValue(setting.key, setting.kind, parsed.value)}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={!dirty}>
            Review change…
          </Button>
          <Button size="sm" variant="ghost" disabled={parsed.ok && sameValue(parsed.value, setting.default)} onClick={() => setDraft(draftFromValue(setting.kind, setting.default))}>
            Use default
          </Button>
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(draftFromValue(setting.kind, setting.value))}>
            Discard
          </Button>
        </div>
      </form>

      {open && parsed.ok ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title="Change this setting?"
          description={<code className="font-mono">{setting.key}</code>}
          effects={[
            <span key="b">Before: <strong>{displayValue(setting.key, setting.kind, setting.value)}</strong></span>,
            <span key="a">After: <strong>{displayValue(setting.key, setting.kind, parsed.value)}</strong></span>,
            'The API and the background worker pick the change up within about 15 seconds.',
            setting.public ? 'This is a PUBLIC setting: the mobile apps read it without signing in, so users see the change.' : 'This setting is internal; it is not exposed to the apps.',
            'The change, with the before and after values and your account, is recorded in the audit log.',
          ]}
          confirmLabel="Save setting"
          onConfirm={async () => {
            const res = await bff.put(`/admin/settings/${setting.key}`, { value: parsed.value });
            if (res.ok || isStaleProblem(res.problem.code)) router.refresh();
            return toAction(res, 'Setting saved.');
          }}
        />
      ) : null}
    </div>
  );
}
