import { ContentTypography } from '@web/shell/layout/ContentTypography';
import type { ReactNode } from 'react';

export default async function SearchLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <ContentTypography locale={locale}>{children}</ContentTypography>;
}
