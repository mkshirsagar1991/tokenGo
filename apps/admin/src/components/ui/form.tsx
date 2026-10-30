import { useId, type ComponentProps, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/format';

const control =
  'w-full rounded-lg border bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70 aria-[invalid=true]:border-danger';
const controlBorder = 'border-line';

interface FieldShellProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

function FieldShell({ id, label, hint, error, required, children, className }: FieldShellProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {required ? (
          <span className="ml-0.5 text-danger-fg" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-danger-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const describedBy = (id: string, hint?: ReactNode, error?: string) => (error ? `${id}-error` : hint ? `${id}-hint` : undefined);

type BaseFieldProps = { label: ReactNode; hint?: ReactNode; error?: string; wrapperClassName?: string };

export function TextField({ label, hint, error, wrapperClassName, className, required, id: idProp, ...rest }: BaseFieldProps & ComponentProps<'input'>) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      <input id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} className={cn(control, controlBorder, 'h-10', className)} {...rest} />
    </FieldShell>
  );
}

export function TextAreaField({ label, hint, error, wrapperClassName, className, required, id: idProp, ...rest }: BaseFieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      <textarea id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} className={cn(control, controlBorder, 'min-h-24 py-2', className)} {...rest} />
    </FieldShell>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({ label, hint, error, wrapperClassName, className, required, id: idProp, options, placeholder, ...rest }: BaseFieldProps & SelectHTMLAttributes<HTMLSelectElement> & { options: readonly Option[]; placeholder?: string }) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      <select id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} className={cn(control, controlBorder, 'h-10 pr-8', className)} {...rest}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckboxField({ label, hint, className, id: idProp, ...rest }: { label: ReactNode; hint?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input id={id} type="checkbox" aria-describedby={hint ? `${id}-hint` : undefined} className="mt-1 h-4 w-4 rounded border-line accent-[var(--brand)]" {...rest} />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-fg-subtle">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Accessible on/off switch (a checkbox with role="switch"). */
export function Switch({ checked, onChange, label, disabled, id: idProp }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-line transition-colors disabled:cursor-not-allowed disabled:opacity-50', checked ? 'bg-brand' : 'bg-surface-2')}
    >
      <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

/** A GET-form filter bar: works without JavaScript, keeps filters in the URL (shareable, back-button friendly). */
export function FilterBar({ action, children, resetHref }: { action: string; children: ReactNode; resetHref?: string }) {
  return (
    <form method="get" action={action} className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-3">
      {children}
      <div className="flex gap-2">
        <button type="submit" className="inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg hover:bg-brand-hover">
          Apply
        </button>
        <a href={resetHref ?? action} className="inline-flex h-10 items-center rounded-lg border border-line bg-surface px-4 text-sm font-medium text-fg hover:bg-surface-2">
          Reset
        </a>
      </div>
    </form>
  );
}
