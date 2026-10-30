import type { Metadata } from 'next';
import { ProblemView } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/layout';
import { SettingRow } from '@/features/settings/components/setting-row';
import { SETTING_GROUPS, groupOf, type SettingView } from '@/features/settings/types';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const res = await serverApi<SettingView[]>('/admin/settings');
  if (!res.ok) return <ProblemView problem={res.problem} permission="settings:manage" what="platform settings" retryHref="/settings" />;

  const groups = new Map<string, SettingView[]>();
  for (const s of res.data) groups.set(groupOf(s.key), [...(groups.get(groupOf(s.key)) ?? []), s]);
  return (
    <>
      <PageHeader title="Settings" description="Platform settings that can change without a release. Each has a type, limits and a built-in default; the API refuses anything outside them. Settings marked Public are visible to the mobile apps before sign-in." />
      <div className="space-y-6">
        {[...groups.entries()].map(([group, items]) => (
          <Card key={group} title={SETTING_GROUPS[group] ?? group} padded={false}>
            {items.map((s) => (
              <SettingRow key={`${s.key}-${s.version}`} setting={s} />
            ))}
          </Card>
        ))}
      </div>
    </>
  );
}
