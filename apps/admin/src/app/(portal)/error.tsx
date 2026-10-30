'use client';

import { TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Logged to the browser console for the operator; the message is generic and carries only Next's opaque digest.
    console.error('Portal render error', error.digest);
  }, [error]);
  return (
    <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-line bg-surface p-8 text-center" role="alert">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger-soft text-danger-fg">
        <TriangleAlert className="h-6 w-6" aria-hidden />
      </div>
      <h2 className="text-lg font-semibold text-fg">Something went wrong</h2>
      <p className="mt-2 text-sm text-fg-muted">This page could not be shown. Nothing was changed. You can try again.</p>
      {error.digest ? <p className="mt-3 text-xs text-fg-subtle">Reference: <code className="font-mono">{error.digest}</code></p> : null}
      <div className="mt-6 flex justify-center">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
