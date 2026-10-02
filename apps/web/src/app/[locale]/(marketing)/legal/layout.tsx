/**
 * 法的文書ページ用レイアウト
 *
 * @description
 * 法的文書ページ（/legal/privacy, /legal/terms等）で使用。
 * 親レイアウトの共通Header/Footerを使用。
 */
import type { ReactNode } from 'react';

import { ContentTypography } from '@web/shell/layout/ContentTypography';

interface LegalLayoutProps {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

export default async function LegalLayout({ children, params }: LegalLayoutProps) {
  const { locale } = await params;
  return (
    <ContentTypography locale={locale} collection="legal" className="bg-background">
      {children}
    </ContentTypography>
  );
}
