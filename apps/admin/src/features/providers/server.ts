import { cache } from 'react';
import type { PageMeta } from '@/lib/api-types';
import { serverApi } from '@/lib/server/api';
import type { Provider } from './types';

/**
 * Provider names by id, so payout/payable/account rows can show a name instead of a bare UUID. Best effort: it covers the first 100
 * providers and is empty when the caller may not list providers (then rows fall back to the short id).
 */
export const getProviderNames = cache(async (): Promise<Map<string, string>> => {
  const res = await serverApi<Provider[], PageMeta>('/admin/providers', { query: { limit: 100 } });
  return new Map(res.ok ? res.data.map((p) => [p.id, p.display_name] as const) : []);
});
