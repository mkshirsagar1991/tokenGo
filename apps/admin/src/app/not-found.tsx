import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
        <h1 className="text-lg font-semibold text-fg">Page not found</h1>
        <p className="mt-2 text-sm text-fg-muted">That page does not exist in the admin portal.</p>
        <Link href="/" className="mt-6 inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg hover:bg-brand-hover">
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
