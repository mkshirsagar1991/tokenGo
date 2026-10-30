import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="mb-6">
      {back ? (
        <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-sm text-fg-subtle hover:text-fg">
          <span aria-hidden>←</span> {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {description ? <p className="mt-1 max-w-3xl text-sm text-fg-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Card({ title, description, actions, children, className, padded = true, id }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; padded?: boolean; id?: string }) {
  return (
    <section id={id} className={cn('rounded-xl border border-line bg-surface', className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            {title ? <h2 className="text-sm font-semibold text-fg">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-fg-subtle">{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

export function StatTile({ label, value, hint, tone = 'neutral', href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'neutral' | 'success' | 'warn' | 'danger'; href?: string }) {
  const valueColor = tone === 'success' ? 'text-success-fg' : tone === 'warn' ? 'text-warn-fg' : tone === 'danger' ? 'text-danger-fg' : 'text-fg';
  const inner = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', valueColor)}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p> : null}
    </>
  );
  const cls = 'block rounded-xl border border-line bg-surface p-4';
  return href ? (
    <Link href={href} className={cn(cls, 'transition-colors hover:bg-surface-2')}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export function DescriptionList({ items, columns = 2 }: { items: Array<{ label: string; value: ReactNode }>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', columns === 1 ? 'grid-cols-1' : columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{i.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-fg">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Tab-style sub navigation made of ordinary links (works without JS, each tab is a real URL). */
export function SubNav({ items, current, label }: { items: Array<{ href: string; label: string }>; current: string; label: string }) {
  return (
    <nav aria-label={label} className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {items.map((i) => {
        const active = current === i.href;
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', active ? 'border-brand text-fg' : 'border-transparent text-fg-subtle hover:text-fg')}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
