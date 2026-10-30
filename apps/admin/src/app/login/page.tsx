import type { Metadata } from 'next';
import { LoginFlow } from '@/features/auth/components/login-flow';
import { param, type SearchParams } from '@/lib/api-types';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginFlow reason={param(sp, 'reason')} next={param(sp, 'next')} />
    </main>
  );
}
