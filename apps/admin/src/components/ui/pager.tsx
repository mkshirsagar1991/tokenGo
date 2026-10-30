import Link from 'next/link';
import type { SearchParams } from '@/lib/api-types';
import { cn } from '@/lib/format';

/** Cursor pager for the API's forward-only pagination. The cursor lives in the URL, so the browser's Back button is "previous page". */
export function Pager({ basePath, searchParams, nextCursor, shown }: { basePath: string; searchParams: SearchParams; nextCursor: string | null | undefined; shown: number }) {
  const hasCursor = typeof searchParams.cursor === 'string' && searchParams.cursor !== '';
  const href = (cursor?: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      const val = Array.isArray(v) ? v[0] : v;
      if (k !== 'cursor' && val) q.set(k, val);
    }
    if (cursor) q.set('cursor', cursor);
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const link = 'inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2';
  return (
    <nav aria-label="Pagination" className="mt-3 flex items-center justify-between gap-3 text-sm text-fg-muted">
      <span>{shown === 0 ? 'No results' : `Showing ${shown} ${shown === 1 ? 'result' : 'results'}${nextCursor ? ' — more available' : ''}`}</span>
      <span className="flex gap-2">
        {hasCursor ? (
          <Link href={href()} className={link}>
            ← First page
          </Link>
        ) : null}
        {nextCursor ? (
          <Link href={href(nextCursor)} className={cn(link)}>
            Next page →
          </Link>
        ) : null}
      </span>
    </nav>
  );
}
