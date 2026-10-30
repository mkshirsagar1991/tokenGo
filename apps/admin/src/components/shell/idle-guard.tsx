'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sendKeepalive } from '@/lib/client/bff';
import { useSessionInfo } from '../providers';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';

/**
 * Client half of the idle timeout. The SERVER enforces it (sealed last-activity time); this component only keeps the session alive
 * while a person is genuinely working (typing in a dialog makes no requests), warns one minute before the limit, and signs out
 * when it is reached so a walk-away screen does not sit there showing data.
 */
const WARN_MS = 60_000;
const CHECK_MS = 5_000;

export function IdleGuard({ idleTimeoutMs, onSignOut }: { idleTimeoutMs: number; onSignOut: () => void | Promise<void> }) {
  const { csrf } = useSessionInfo();
  const lastActivity = useRef(0);
  const lastPing = useRef(0);
  const [remaining, setRemaining] = useState<number | null>(null);

  const stay = useCallback(async () => {
    lastActivity.current = Date.now();
    lastPing.current = Date.now();
    setRemaining(null);
    await sendKeepalive(csrf);
  }, [csrf]);

  useEffect(() => {
    lastActivity.current = Date.now();
    lastPing.current = Date.now();
    const mark = () => {
      lastActivity.current = Date.now();
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'mousemove'];
    for (const e of events) window.addEventListener(e, mark, { passive: true });

    const pingEvery = Math.min(5 * 60_000, Math.max(20_000, idleTimeoutMs / 3));
    const timer = window.setInterval(() => {
      const now = Date.now();
      const idleFor = now - lastActivity.current;
      if (idleFor >= idleTimeoutMs - 2_000) {
        void onSignOut();
        return;
      }
      const warnAt = Math.min(WARN_MS, idleTimeoutMs / 2);
      if (idleFor >= idleTimeoutMs - warnAt) {
        setRemaining(Math.max(0, Math.ceil((idleTimeoutMs - idleFor) / 1000)));
        return;
      }
      setRemaining(null);
      // Active recently and the server has not heard from us for a while: tell it.
      if (lastActivity.current > lastPing.current && now - lastPing.current >= pingEvery) {
        lastPing.current = now;
        void sendKeepalive(csrf);
      }
    }, CHECK_MS);

    return () => {
      for (const e of events) window.removeEventListener(e, mark);
      window.clearInterval(timer);
    };
  }, [idleTimeoutMs, onSignOut, csrf]);

  return (
    <Dialog
      open={remaining !== null}
      onClose={() => void stay()}
      size="sm"
      title="Still there?"
      description="For your security you will be signed out soon because of inactivity."
      footer={
        <>
          <Button variant="secondary" onClick={() => void onSignOut()}>
            Sign out now
          </Button>
          <Button variant="primary" onClick={() => void stay()}>
            Stay signed in
          </Button>
        </>
      }
    >
      <p className="text-sm text-fg-muted">
        Signing out in <strong className="tabular-nums text-fg">{remaining ?? 0}</strong> seconds.
      </p>
    </Dialog>
  );
}
