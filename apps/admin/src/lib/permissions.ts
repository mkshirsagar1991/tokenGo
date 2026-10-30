/**
 * Permissions are fixed `resource:action` strings granted by roles (ADR-0006). The portal hides what the signed-in user cannot do,
 * but the API is the authority: every call is re-checked there, and a 403 from it is always handled.
 */
export const PERMISSIONS = {
  'category:manage': 'Create, update, enable or disable categories and service types',
  'provider:read_any': 'View any provider',
  'provider:verify': 'Start review, approve or reject provider verification',
  'provider:suspend': 'Suspend or reinstate a provider',
  'pricing:read': 'View commission rules and cancellation policies',
  'pricing:manage': 'Create new versions of commission rules and cancellation policies',
  'ledger:read': 'View ledger integrity reports',
  'payments:read': 'View payments, webhook events, refunds and reconciliation results',
  'refund:create': 'Initiate a refund to the original payment instrument',
  'payments:reconcile': 'Run payment reconciliation against the provider',
  'payout:read_any': 'View payouts, payables, holds and bank accounts (masked)',
  'payout:operate': 'Run payouts, refresh them, freeze or unfreeze a provider',
  'payout:reconcile': 'Run payout reconciliation',
  'audit:read': 'Read the audit log',
  'settings:manage': 'Change platform settings',
  'report:read': 'View platform reports',
  'user:read_any': 'View any user account (phone numbers masked)',
  'user:suspend': 'Suspend or reinstate a user account',
  'role:read': 'View the role catalogue and what each role can do',
  'role:assign': 'Grant or revoke roles',
  'wallet:read_any': 'View any customer wallet, masked (not yet in the portal)',
  'appointment:read_any': 'View any booking (not yet in the portal)',
  'support:handle': 'Read, assign and answer support cases and disputes (not yet in the portal)',
  'dispute:resolve': 'Decide a dispute, refunding up to the operator limit (not yet in the portal)',
  'dispute:resolve_large': 'Decide a dispute that refunds more than the operator limit (not yet in the portal)',
  'document:review': 'Open a provider’s documents and verify or reject them (not yet in the portal)',
  'review:moderate': 'Hide or restore customer reviews (not yet in the portal)',
  'notification:read_any': 'View notification delivery records (not yet in the portal)',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(granted: readonly string[], required: Permission): boolean {
  return granted.includes(required);
}

/** True when `anyOf` is empty (no requirement) or the user holds at least one of them. */
export function hasAny(granted: readonly string[], anyOf: readonly Permission[]): boolean {
  return anyOf.length === 0 || anyOf.some((p) => granted.includes(p));
}

export function describePermission(code: string): string {
  return (PERMISSIONS as Record<string, string>)[code] ?? code;
}
