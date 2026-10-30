'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createBffClient, type BffClient } from '@/lib/client/bff';
import { hasPermission, type Permission } from '@/lib/permissions';
import { ToastProvider } from './ui/toast';

interface SessionContextValue {
  csrf: string;
  permissions: readonly string[];
  idleTimeoutMs: number;
  userId: string;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function AppProviders({ csrf, permissions, idleTimeoutMs, userId, children }: SessionContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ csrf, permissions, idleTimeoutMs, userId }), [csrf, permissions, idleTimeoutMs, userId]);
  return (
    <SessionContext.Provider value={value}>
      <ToastProvider>{children}</ToastProvider>
    </SessionContext.Provider>
  );
}

function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSessionContext must be used inside <AppProviders>');
  return ctx;
}

/** A BFF client bound to this session's CSRF token. */
export function useBff(): BffClient {
  const { csrf } = useSessionContext();
  return useMemo(() => createBffClient(csrf), [csrf]);
}

/** UI-level permission check (hides actions). The API remains the authority and still answers 403. */
export function useCan(): (p: Permission) => boolean {
  const { permissions } = useSessionContext();
  return (p) => hasPermission(permissions, p);
}

export const useSessionInfo = (): SessionContextValue => useSessionContext();
