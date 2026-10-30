'use client';

import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/format';

export interface ToastInput {
  tone: 'success' | 'error' | 'info';
  message: string;
  /** API request id, shown on errors so an operator can quote it (audit trail). */
  reference?: string;
}
interface ToastItem extends ToastInput {
  id: number;
}

export interface ToastApi {
  success(message: string): void;
  error(message: string, reference?: string): void;
  info(message: string): void;
}

const noop: ToastApi = { success: () => undefined, error: () => undefined, info: () => undefined };
const ToastContext = createContext<ToastApi>(noop);

/** Falls back to a no-op outside a provider, so components stay usable in isolation (and in tests). */
export const useToast = (): ToastApi => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((cur) => cur.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setItems((cur) => [...cur.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.tone === 'error' ? 15_000 : 6_000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push({ tone: 'success', message }),
      error: (message, reference) => push({ tone: 'error', message, reference }),
      info: (message) => push({ tone: 'info', message }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border p-3 text-sm shadow-lg',
              t.tone === 'error' ? 'border-danger/40 bg-danger-soft text-danger-fg' : t.tone === 'success' ? 'border-line bg-success-soft text-success-fg' : 'border-line bg-surface text-fg',
            )}
          >
            {t.tone === 'error' ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.message}</p>
              {t.reference ? <p className="mt-0.5 break-all text-xs opacity-80">Ref {t.reference}</p> : null}
            </div>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="rounded p-0.5 opacity-70 hover:opacity-100">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
