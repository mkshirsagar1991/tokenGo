'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { shortId } from '@/lib/format';

/** Shows the first 8 characters of an id (full id on hover) with a copy button. */
export function IdChip({ id, label }: { id: string | null | undefined; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!id) return <span className="text-fg-subtle">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg-muted" title={id}>
        {shortId(id)}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label ?? 'id'} ${id}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(id)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => undefined);
        }}
        className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success-fg" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </span>
  );
}
