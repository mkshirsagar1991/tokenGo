import type { Metadata } from 'next';
import { ProblemView } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/layout';
import { CategoriesTable, CreateCategoryButton } from '@/features/catalog/components/category-manager';
import type { Category } from '@/features/catalog/types';
import { serverApi } from '@/lib/server/api';

export const metadata: Metadata = { title: 'Categories' };

export default async function CatalogPage() {
  const res = await serverApi<Category[]>('/admin/categories');
  return (
    <>
      <PageHeader title="Categories & services" description="The verticals customers can book. Only enabled categories appear in the apps. Open a category to manage its service types." actions={<CreateCategoryButton />} />
      {res.ok ? <CategoriesTable categories={[...res.data].sort((a, b) => a.sort_order - b.sort_order)} /> : <ProblemView problem={res.problem} permission="category:manage" what="the catalogue" retryHref="/catalog" />}
    </>
  );
}
