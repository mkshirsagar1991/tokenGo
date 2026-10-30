import { cache } from 'react';
import { getProviderNames } from '@/features/providers/server';
import { serverApi } from '@/lib/server/api';
import type { Category, ScopeOptions } from './types';

/** Names for the scope pickers and labels (categories + providers). Best effort: whatever the caller may not read is simply absent. */
export const getScopeOptions = cache(async (): Promise<ScopeOptions> => {
  const [cats, providers] = await Promise.all([serverApi<Category[]>('/admin/categories'), getProviderNames()]);
  return {
    categories: cats.ok ? cats.data.map((c) => ({ value: c.id, label: c.name })) : [],
    providers: [...providers.entries()].map(([value, label]) => ({ value, label })),
  };
});
