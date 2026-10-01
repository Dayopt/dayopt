import { ContentSearch } from '@web/features/search';
import { setRequestLocale } from 'next-intl/server';

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { q = '' } = await searchParams;
  return <ContentSearch submittedQuery={q} />;
}
