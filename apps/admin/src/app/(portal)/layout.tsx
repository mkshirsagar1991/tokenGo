import { cookies } from 'next/headers';
import { AppProviders } from '@/components/providers';
import { AppShell, type ModeBadge } from '@/components/shell/app-shell';
import { ProblemView } from '@/components/ui/feedback';
import { visibleNav } from '@/config/navigation';
import { getAppConfig, getMe, getSession, redirectToSignIn, type AppConfig } from '@/lib/server/api';
import { getConfig } from '@/lib/server/config';
import type { ApiResult } from '@/lib/problem';

export const dynamic = 'force-dynamic';

/** An honest, always-visible statement of the payment mode, taken from the API (public /app-config). */
function modeBadge(cfg: ApiResult<AppConfig>): ModeBadge {
  if (!cfg.ok) return { label: 'Payment mode unknown', tone: 'neutral', title: 'The API did not report its payment mode.' };
  const p = cfg.data.payments;
  if (p.provider === 'disabled') return { label: 'Payments disabled', tone: 'neutral', title: 'No payment provider is enabled.' };
  if (p.test_mode) return { label: 'TEST MODE', detail: p.provider, tone: 'warn', title: 'Real money is off. Payments run against a sandbox/test provider; nothing here moves real funds.' };
  return { label: 'LIVE', detail: p.provider, tone: 'danger', title: 'Live payments are enabled. Actions here can move real money.' };
}

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) return redirectToSignIn();

  const [me, cfg] = await Promise.all([getMe(), getAppConfig()]);
  if (!me.ok) return <ProblemView problem={me.problem} />;

  const theme = (await cookies()).get('tg_theme')?.value;
  const groups = visibleNav(me.data.permissions);
  return (
    <AppProviders csrf={session.csrf} permissions={me.data.permissions} idleTimeoutMs={getConfig().idleTimeoutMs} userId={me.data.id}>
      <AppShell groups={groups} userLabel={me.data.phone_masked} mode={modeBadge(cfg)} environment={cfg.ok ? cfg.data.environment : null} theme={theme === 'light' || theme === 'dark' ? theme : 'system'} idleTimeoutMs={getConfig().idleTimeoutMs}>
        {children}
      </AppShell>
    </AppProviders>
  );
}
