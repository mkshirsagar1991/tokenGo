import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/format';

/**
 * Plain semantic tables inside a horizontally scrolling card, so they stay usable on a tablet or phone.
 * Pass `stickyFirst` on a column's TH/TD to keep it visible while scrolling sideways.
 *
 * The wrapper is `relative` on purpose: `sr-only` text (the caption, a visually hidden "Actions" header) is absolutely positioned,
 * and an absolutely positioned box is only clipped by a scroll container that is its containing block. Without it a hidden
 * span at the far right of a wide table widens the whole PAGE and the page scrolls sideways.
 */
export function TableCard({ children, caption, className }: { children: ReactNode; caption: string; className?: string }) {
  return (
    <div className={cn('relative overflow-x-auto rounded-xl border border-line bg-surface', className)} role="region" aria-label={caption} tabIndex={0}>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export const THead = ({ children }: { children: ReactNode }) => <thead className="border-b border-line bg-surface-2 text-xs uppercase tracking-wide text-fg-subtle">{children}</thead>;
export const TBody = ({ children }: { children: ReactNode }) => <tbody className="divide-y divide-line">{children}</tbody>;
export const TR = ({ children, className, ...rest }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn('align-top hover:bg-surface-2/60', className)} {...rest}>
    {children}
  </tr>
);

export function TH({ children, className, align, stickyFirst, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'right'; stickyFirst?: boolean }) {
  return (
    <th scope="col" className={cn('whitespace-nowrap px-3 py-2.5 font-medium', align === 'right' && 'text-right', stickyFirst && 'sticky left-0 bg-surface-2', className)} {...rest}>
      {children}
    </th>
  );
}

export function TD({ children, className, align, stickyFirst, mono, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'right'; stickyFirst?: boolean; mono?: boolean }) {
  return (
    <td className={cn('px-3 py-2.5 text-fg', align === 'right' && 'text-right tabular-nums', mono && 'font-mono text-xs', stickyFirst && 'sticky left-0 z-[1] bg-surface', className)} {...rest}>
      {children}
    </td>
  );
}

export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-fg-muted">
        {children}
      </td>
    </tr>
  );
}
