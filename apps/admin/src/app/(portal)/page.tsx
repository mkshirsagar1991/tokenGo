import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/layout';
import { DashboardView } from '@/features/dashboard/components/dashboard-view';
import { loadDashboard } from '@/features/dashboard/load';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const d = await loadDashboard();
  return (
    <>
      <PageHeader title="Dashboard" description="What needs attention across providers, payments and payouts. Every figure is read live from the API." />
      <DashboardView d={d} />
    </>
  );
}
