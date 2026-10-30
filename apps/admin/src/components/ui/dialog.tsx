'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/format';
import { fieldErrors, problemMessage, type ActionResult, type Problem } from '@/lib/problem';
import { Alert } from './feedback';
import { Button } from './button';
import { TextAreaField, TextField } from './form';
import { useToast } from './toast';

/**
 * Modal built on the native <dialog> element: the browser traps focus, makes the page behind inert, closes on Escape and returns
 * focus to the trigger. While `busy` the dialog cannot be dismissed (so an in-flight money action is never abandoned on screen).
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', busy = false }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg'; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      className={cn('m-auto w-[calc(100%-2rem)] rounded-2xl border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50', size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl')}
    >
      {open ? (
        <div className="flex max-h-[calc(100vh-2rem)] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-fg">
                {title}
              </h2>
              {description ? (
                <div id={descId} className="mt-1 text-sm text-fg-muted">
                  {description}
                </div>
              ) : null}
            </div>
            <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog" className="rounded-lg p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg disabled:opacity-40">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export interface ReasonSpec {
  label?: string;
  min: number;
  max: number;
  placeholder?: string;
  help?: string;
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Exactly what will happen, in plain words. */
  description: ReactNode;
  /** Consequences, one per line. */
  effects?: ReactNode[];
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** When present a typed reason of min..max characters is REQUIRED before the button enables (it is sent to the API and audited). */
  reason?: ReasonSpec;
  /** When present the operator must type this exact text to enable the button (highest-risk actions). */
  confirmText?: string;
  /** Extra inputs rendered above the reason (e.g. a refund amount). */
  children?: ReactNode;
  /** Extra validation from the caller; the button stays disabled while false. */
  canConfirm?: boolean;
  /** Maps the API's field name (e.g. `reason`) to what the dialog should show under its own reason box. */
  reasonField?: string;
  onConfirm: (input: { reason: string }) => Promise<ActionResult>;
  onSuccess?: (message?: string) => void;
  /** Rendered inside the dialog after a successful action instead of closing it (e.g. a result summary). */
  renderResult?: (message?: string) => ReactNode;
  /** Dialog title once the result is showing (defaults to the original title). */
  resultTitle?: string;
}

/**
 * The portal's one confirmation pattern for every money or risk action: states what will happen, collects a reason where the API
 * accepts one, disables the button while the request is in flight (and also ignores a second activation, since an idempotent
 * endpoint is a safety net, not a licence to double-submit), and shows the API's answer (with its request id) inline.
 */
export function ConfirmDialog({ open, onClose, title, description, effects, confirmLabel, tone = 'primary', reason, confirmText, children, canConfirm = true, reasonField = 'reason', onConfirm, onSuccess, renderResult, resultTitle }: ConfirmDialogProps) {
  const toast = useToast();
  const [reasonText, setReasonText] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<{ message?: string } | null>(null);
  const inFlight = useRef(false);

  const trimmed = reasonText.trim();
  const reasonOk = !reason || (trimmed.length >= reason.min && trimmed.length <= reason.max);
  const typedOk = !confirmText || typed.trim() === confirmText;
  const ready = reasonOk && typedOk && canConfirm;
  const apiReasonError = problem ? fieldErrors(problem)[reasonField] : undefined;

  function reset() {
    setReasonText('');
    setTyped('');
    setProblem(null);
    setDone(null);
  }

  async function submit() {
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await onConfirm({ reason: trimmed });
      if (result.ok) {
        toast.success(result.message ?? 'Done.');
        onSuccess?.(result.message);
        if (renderResult) setDone({ message: result.message });
        else {
          reset();
          onClose();
        }
      } else {
        setProblem(result.problem); // shown inline: a toast would sit behind the modal
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      busy={busy}
      title={done && resultTitle ? resultTitle : title}
      description={done ? undefined : description}
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={submit} loading={busy} disabled={!ready}>
              {confirmLabel}
            </Button>
          </>
        )
      }
    >
      {done ? (
        renderResult?.(done.message)
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {effects && effects.length > 0 ? (
            <ul className="list-disc space-y-1 rounded-lg bg-surface-2 py-3 pl-8 pr-4 text-sm text-fg-muted">
              {effects.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
          {children}
          {reason ? (
            <TextAreaField
              label={reason.label ?? 'Reason'}
              required
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder={reason.placeholder}
              maxLength={reason.max}
              disabled={busy}
              hint={reason.help ?? `${reason.min}–${reason.max} characters. It is recorded in the audit log with your name.`}
              error={apiReasonError ?? (trimmed.length > 0 && trimmed.length < reason.min ? `Enter at least ${reason.min} characters (${trimmed.length} so far).` : undefined)}
            />
          ) : null}
          {confirmText ? (
            <TextField label={`Type ${confirmText} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} />
          ) : null}
          {problem && !apiReasonError ? (
            <Alert tone="danger" title={problemMessage(problem)}>
              {problem.requestId ? <span className="text-xs">Reference: {problem.requestId}</span> : null}
            </Alert>
          ) : null}
          {/* Lets Enter submit when the dialog has a single text input. */}
          <button type="submit" hidden disabled={!ready || busy} aria-hidden tabIndex={-1} />
        </form>
      )}
    </Dialog>
  );
}
