import { CircleCheck, Info, LoaderCircle, ShieldAlert, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, humanize } from '@/lib/format';
import { describePermission } from '@/lib/permissions';
import { describeProblem, type Problem } from '@/lib/problem';
import { LinkButton } from './button';

export type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'info' | 'brand';

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-muted',
  success: 'bg-success-soft text-success-fg',
  warn: 'bg-warn-soft text-warn-fg',
  danger: 'bg-danger-soft text-danger-fg',
  info: 'bg-info-soft text-info-fg',
  brand: 'bg-brand-soft text-brand-soft-fg',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', toneClasses[tone], className)}>
      {children}
    </span>
  );
}

/** One place that decides how every status in the portal is coloured. */
const STATUS_TONES: Record<string, Tone> = {
  // users
  ACTIVE: 'success', DEACTIVATED: 'neutral', DELETED: 'neutral',
  // providers
  DRAFT: 'neutral', SUBMITTED: 'info', UNDER_REVIEW: 'warn', APPROVED: 'success', REJECTED: 'danger', SUSPENDED: 'danger',
  // payments / refunds / webhooks
  CAPTURED: 'success', FAILED: 'danger', QUARANTINED: 'warn', PROCESSING: 'warn', SUCCEEDED: 'success',
  RECEIVED: 'info', PROCESSED: 'success', IGNORED: 'neutral',
  // payouts / payables / accounts
  RESERVED: 'info', PAID: 'success', ACCRUED: 'info', IN_PAYOUT: 'warn', CLAWED_BACK: 'danger',
  PENDING_VERIFICATION: 'warn', VERIFIED: 'success', VERIFICATION_FAILED: 'danger', REPLACED: 'neutral',
  // reconciliation
  MATCHED: 'success', AMOUNT_MISMATCH: 'danger', STATUS_MISMATCH: 'danger', MISSING_INTERNAL: 'danger', MISSING_EXTERNAL: 'warn', REFUND_MISMATCH: 'danger',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONES[status] ?? (status === 'SUBMITTED' ? 'info' : 'neutral')}>{label ?? humanize(status)}</Badge>;
}

export function Alert({ tone = 'info', title, children, actions, className }: { tone?: 'info' | 'success' | 'warn' | 'danger'; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  const Icon = tone === 'success' ? CircleCheck : tone === 'info' ? Info : TriangleAlert;
  return (
    <div role={tone === 'danger' || tone === 'warn' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-lg p-3 text-sm', toneClasses[tone], className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title ? 'mt-0.5' : undefined)}>{children}</div> : null}
        {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-fg-muted">
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-base font-semibold text-fg">{title}</p>
      {children ? <p className="max-w-md text-sm text-fg-muted">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** The portal's 403 experience: say what was needed, why it is missing, and what to do. */
export function AccessDenied({ permission, what }: { permission?: string; what?: string }) {
  return (
    <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-line bg-surface p-8 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-warn-soft text-warn-fg">
        <ShieldAlert className="h-6 w-6" aria-hidden />
      </div>
      <h2 className="text-lg font-semibold text-fg">You do not have access to {what ?? 'this area'}</h2>
      <p className="mt-2 text-sm text-fg-muted">You are signed in, but your role does not include the permission this needs. This was decided by the server, not just hidden in the menu.</p>
      {permission ? (
        <p className="mt-4 rounded-lg bg-surface-2 p-3 text-left text-sm">
          <span className="text-fg-subtle">Required permission</span>
          <br />
          <code className="font-mono text-fg">{permission}</code>
          <span className="block text-fg-muted">{describePermission(permission)}</span>
        </p>
      ) : null}
      <p className="mt-4 text-sm text-fg-muted">If you need this, ask a platform administrator to grant you a role that includes it.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <LinkButton href="/" variant="secondary">
          Back to dashboard
        </LinkButton>
        <LinkButton href="/account" variant="ghost">
          View my access
        </LinkButton>
      </div>
    </div>
  );
}

/** Full-region error state for a failed load. Handles 403 / 404 / everything else; `retryHref` re-requests the same page. */
export function ProblemView({ problem, retryHref, permission, what }: { problem: Problem; retryHref?: string; permission?: string; what?: string }) {
  if (problem.status === 403 && problem.code !== 'ACCOUNT_DISABLED' && problem.code !== 'MFA_REQUIRED') return <AccessDenied permission={permission} what={what} />;
  const d = describeProblem(problem);
  return (
    <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-line bg-surface p-8 text-center" role="alert">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger-soft text-danger-fg">
        <TriangleAlert className="h-6 w-6" aria-hidden />
      </div>
      <h2 className="text-lg font-semibold text-fg">{d.title}</h2>
      <p className="mt-2 text-sm text-fg-muted">{d.message}</p>
      {problem.requestId ? <p className="mt-3 text-xs text-fg-subtle">Reference for support: <code className="font-mono">{problem.requestId}</code></p> : null}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {retryHref && d.retryable ? (
          <Link href={retryHref} className="inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg hover:bg-brand-hover">
            Try again
          </Link>
        ) : null}
        <LinkButton href="/" variant="secondary">
          Back to dashboard
        </LinkButton>
      </div>
    </div>
  );
}

/** Small inline version of ProblemView, for one card/tile that failed while the rest of the page is fine. */
export function InlineProblem({ problem, permission }: { problem: Problem; permission?: string }) {
  if (problem.status === 403) {
    return (
      <p className="text-sm text-fg-subtle">
        No access{permission ? <> (needs <code className="font-mono text-xs">{permission}</code>)</> : null}.
      </p>
    );
  }
  return (
    <p role="alert" className="text-sm text-danger-fg">
      {describeProblem(problem).message}
      {problem.requestId ? <span className="block text-xs text-fg-subtle">Ref {problem.requestId}</span> : null}
    </p>
  );
}
