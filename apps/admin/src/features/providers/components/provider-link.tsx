import Link from 'next/link';
import { shortId } from '@/lib/format';

/** A provider as a link to its page: the name when known, the short id otherwise. */
export function ProviderLink({ id, names }: { id: string; names?: Map<string, string> }) {
  const name = names?.get(id);
  return (
    <Link href={`/providers/${id}`} className="text-brand-soft-fg hover:underline" title={id}>
      {name ?? <code className="font-mono text-xs">{shortId(id)}</code>}
      {name ? <span className="ml-1 font-mono text-xs text-fg-subtle">{shortId(id)}</span> : null}
    </Link>
  );
}
