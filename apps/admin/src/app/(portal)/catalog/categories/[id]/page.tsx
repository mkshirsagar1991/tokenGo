import type { Metadata } from 'next';
import { Badge, ProblemView } from '@/components/ui/feedback';
import { Card, DescriptionList, PageHeader } from '@/components/ui/layout';
import { ServiceTypesSection, ToggleCategoryButton } from '@/features/catalog/components/category-manager';
import type { Category, ServiceType } from '@/features/catalog/types';
import { humanize, isUuid } from '@/lib/format';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Category' };

export default async function CategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return <ProblemView problem={{ status: 404, code: 'NOT_FOUND', detail: 'That is not a valid category id.' }} />;
  const [cats, types] = await Promise.all([serverApi<Category[]>('/admin/categories'), serverApi<ServiceType[]>(`/admin/categories/${id}/service-types`)]);
  if (!cats.ok) return <ProblemView problem={cats.problem} permission="category:manage" what="the catalogue" retryHref={`/catalog/categories/${id}`} />;
  const category = cats.data.find((c) => c.id === id);
  if (!category) return <ProblemView problem={{ status: 404, code: 'NOT_FOUND', detail: 'Category not found.' }} />;
  return (
    <>
      <PageHeader back={{ href: '/catalog', label: 'All categories' }} title={<span className="flex flex-wrap items-center gap-3">{category.name} {category.is_active ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}</span>} description={category.description ?? undefined} actions={<ToggleCategoryButton category={category} />} />
      <Card className="mb-6">
        <DescriptionList items={[{ label: 'Code', value: <code className="font-mono">{category.code}</code> }, { label: 'Booking flow', value: humanize(category.booking_flow_type) }, { label: 'Sort order', value: category.sort_order }, { label: 'Record version', value: category.version }]} columns={3} />
      </Card>
      {types.ok ? <ServiceTypesSection category={category} serviceTypes={types.data} /> : <ProblemView problem={types.problem} permission="category:manage" what="service types" retryHref={`/catalog/categories/${id}`} />}
    </>
  );
}
