import { hasAny, type Permission } from '@/lib/permissions';

/**
 * The portal's navigation, as data. EXTENSION POINT: a new admin area is added by (1) a folder under src/features/<area>,
 * (2) route files under src/app/(portal)/<area>, (3) ONE entry here, (4) allowlist rules in src/lib/server/allowlist.ts.
 * An item is shown only to users holding at least one permission in `anyOf` (an empty list = everyone). Hiding is a convenience:
 * every page re-checks on the server and the API enforces the permission on every call.
 */
export type IconName = 'dashboard' | 'providers' | 'users' | 'roles' | 'catalog' | 'commission' | 'cancellation' | 'transactions' | 'webhooks' | 'refunds' | 'reconcile' | 'payouts' | 'holds' | 'payables' | 'accounts' | 'reports' | 'audit' | 'settings' | 'account';

export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  anyOf: readonly Permission[];
}
export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
  { label: 'Overview', items: [{ label: 'Dashboard', href: '/', icon: 'dashboard', anyOf: [] }] },
  {
    label: 'People',
    items: [
      { label: 'Providers', href: '/providers', icon: 'providers', anyOf: ['provider:read_any'] },
      { label: 'Users', href: '/users', icon: 'users', anyOf: ['user:read_any'] },
      { label: 'Roles', href: '/roles', icon: 'roles', anyOf: ['role:read'] },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { label: 'Categories & services', href: '/catalog', icon: 'catalog', anyOf: ['category:manage'] },
      { label: 'Commission rules', href: '/catalog/commission', icon: 'commission', anyOf: ['pricing:read'] },
      { label: 'Cancellation policies', href: '/catalog/cancellation', icon: 'cancellation', anyOf: ['pricing:read'] },
    ],
  },
  {
    label: 'Payments',
    items: [
      { label: 'Transactions', href: '/payments/transactions', icon: 'transactions', anyOf: ['payments:read'] },
      { label: 'Webhook events', href: '/payments/webhooks', icon: 'webhooks', anyOf: ['payments:read'] },
      { label: 'Refunds', href: '/payments/refunds', icon: 'refunds', anyOf: ['payments:read'] },
      { label: 'Reconciliation', href: '/payments/reconciliation', icon: 'reconcile', anyOf: ['payments:read'] },
    ],
  },
  {
    label: 'Payouts',
    items: [
      { label: 'Payouts', href: '/payouts', icon: 'payouts', anyOf: ['payout:read_any'] },
      { label: 'Holds', href: '/payouts/holds', icon: 'holds', anyOf: ['payout:read_any'] },
      { label: 'Payables', href: '/payouts/payables', icon: 'payables', anyOf: ['payout:read_any'] },
      { label: 'Bank accounts', href: '/payouts/accounts', icon: 'accounts', anyOf: ['payout:read_any'] },
      { label: 'Reconciliation', href: '/payouts/reconciliation', icon: 'reconcile', anyOf: ['payout:read_any'] },
    ],
  },
  {
    label: 'Insight',
    items: [
      { label: 'Reports', href: '/reports', icon: 'reports', anyOf: ['report:read'] },
      { label: 'Audit log', href: '/audit', icon: 'audit', anyOf: ['audit:read'] },
    ],
  },
  { label: 'Platform', items: [{ label: 'Settings', href: '/settings', icon: 'settings', anyOf: ['settings:manage'] }] },
];

/** Groups with only the items this user may see; empty groups disappear. */
export function visibleNav(granted: readonly string[]): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => hasAny(granted, i.anyOf)) })).filter((g) => g.items.length > 0);
}

/** The nav item whose href is the longest match for the path (so /catalog/commission highlights Commission, not Categories). */
export function activeHref(pathname: string, groups: readonly NavGroup[]): string | null {
  let best: string | null = null;
  for (const g of groups) {
    for (const i of g.items) {
      const match = i.href === '/' ? pathname === '/' : pathname === i.href || pathname.startsWith(`${i.href}/`);
      if (match && (best === null || i.href.length > best.length)) best = i.href;
    }
  }
  return best;
}
