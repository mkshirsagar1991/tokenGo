'use client';

import Image from 'next/image';
import {
  Activity,
  Banknote,
  ChartColumn,
  CreditCard,
  FileClock,
  KeyRound,
  Landmark,
  LayoutDashboard,
  Layers,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Percent,
  Receipt,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  Store,
  Sun,
  Undo2,
  Users,
  Webhook,
  X,
  CirclePause,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { activeHref, type IconName, type NavGroup } from '@/config/navigation';
import { authCall } from '@/lib/client/bff';
import { cn } from '@/lib/format';
import { Badge, type Tone } from '../ui/feedback';
import { IdleGuard } from './idle-guard';

const ICONS: Record<IconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  providers: Store,
  users: Users,
  roles: KeyRound,
  catalog: Layers,
  commission: Percent,
  cancellation: FileClock,
  transactions: CreditCard,
  webhooks: Webhook,
  refunds: Undo2,
  reconcile: Scale,
  payouts: Banknote,
  holds: CirclePause,
  payables: Receipt,
  accounts: Landmark,
  reports: ChartColumn,
  audit: ScrollText,
  settings: Settings,
  account: ShieldCheck,
};

export interface ModeBadge {
  label: string;
  /** Shown after the label from the sm breakpoint up (kept short on phones). */
  detail?: string;
  tone: Tone;
  title: string;
}

type Theme = 'system' | 'light' | 'dark';
const THEME_COOKIE = 'tg_theme';

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', theme);
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Strict`;
}

function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <button
      type="button"
      onClick={() => {
        const t = next[theme];
        setTheme(t);
        applyTheme(t);
      }}
      aria-label={`Theme: ${theme}. Switch to ${next[theme]}.`}
      title={`Theme: ${theme}`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg"
    >
      <Icon className="h-4.5 w-4.5" aria-hidden />
    </button>
  );
}

export function AppShell({ groups, userLabel, mode, environment, theme, idleTimeoutMs, children }: { groups: NavGroup[]; userLabel: string; mode: ModeBadge; environment: string | null; theme: Theme; idleTimeoutMs: number; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const active = activeHref(pathname, groups);

  // Escape closes the drawer; following a link closes it too (onClick on each link).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const signingOutRef = useRef(false);
  const signOut = useCallback(async (reason: 'signed_out' | 'idle' = 'signed_out') => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setSigningOut(true);
    await authCall('logout');
    // A full navigation on purpose: it drops all client state and goes through the proxy again.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/login?reason=${reason}`);
  }, []);
  const idleSignOut = useCallback(() => signOut('idle'), [signOut]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-brand-fg">
        Skip to content
      </a>

      {open ? <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" aria-hidden onClick={() => setOpen(false)} /> : null}

      {/* Below `lg` a closed drawer is only slid off-screen, so it must also be `invisible`: otherwise its links stay in the tab order
          and the accessibility tree. Visibility is transitioned with the slide, so closing still animates and then hides. */}
      <aside id="sidebar" aria-label="Main navigation" className={cn('fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-line bg-surface transition-[transform,visibility] lg:static lg:z-auto lg:w-auto lg:max-w-none lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full max-lg:invisible')}>
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-fg">
            <Image src="/brand/icon.png" alt="" width={28} height={28} unoptimized className="h-7 w-7 rounded-lg" />
            TokenGo Admin
          </Link>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="rounded-lg p-1.5 text-fg-subtle hover:bg-surface-2 lg:hidden">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <nav className="flex-1 space-y-5 px-3 py-4">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-fg-subtle">{g.label}</p>
              <ul className="space-y-0.5">
                {g.items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const isActive = active === item.href;
                  return (
                    <li key={item.href}>
                      <Link href={item.href} onClick={() => setOpen(false)} aria-current={isActive ? 'page' : undefined} className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium', isActive ? 'bg-brand-soft text-brand-soft-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg')}>
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="shrink-0 border-t border-line p-3 text-xs text-fg-subtle">
          <Link href="/account" onClick={() => setOpen(false)} className="mb-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-fg-muted hover:bg-surface-2 hover:text-fg">
            <ShieldCheck className="h-4 w-4" aria-hidden /> My access
          </Link>
          {environment ? (
            <p className="flex items-center gap-1.5 px-2">
              <Activity className="h-3.5 w-3.5" aria-hidden /> Environment: <span className="font-medium text-fg-muted">{environment}</span>
            </p>
          ) : null}
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur sm:px-6">
          <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open} aria-controls="sidebar" className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 lg:hidden">
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          <Badge tone={mode.tone} title={mode.title} className="max-w-[60vw] truncate">
            {mode.label}
            {mode.detail ? <span className="hidden sm:inline"> · {mode.detail}</span> : null}
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <span className="hidden text-sm text-fg-muted sm:inline" title="Signed in as (phone masked)">
              {userLabel}
            </span>
            <ThemeToggle initial={theme} />
            <button type="button" onClick={() => void signOut()} disabled={signingOut} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
              <LogOut className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{signingOut ? 'Signing out…' : 'Sign out'}</span>
              <span className="sr-only sm:hidden">Sign out</span>
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
      <IdleGuard idleTimeoutMs={idleTimeoutMs} onSignOut={idleSignOut} />
    </div>
  );
}
