import type { Metadata } from 'next';

import { Toaster } from '@dayopt/components';
import { ContentTypography } from '@web/shell/layout/ContentTypography';

export const metadata: Metadata = {
  title: {
    template: '%s | Dayopt Blog',
    default: 'Blog | Dayopt',
  },
  description: 'SaaS開発、テクノロジー、ビジネス戦略に関する最新の知見をお届けします。',
  keywords: 'SaaS, blog, technology, development, business, startup, insights',
  authors: [{ name: 'Dayopt Team' }],
  openGraph: {
    title: 'Blog | Dayopt',
    description: 'SaaS開発、テクノロジー、ビジネス戦略に関する最新の知見。',
    type: 'website',
    siteName: 'Dayopt',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Blog | Dayopt',
    description: 'SaaS開発、テクノロジー、ビジネス戦略に関する最新の知見。',
  },
  alternates: {
    canonical: '/blog',
  },
};

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <ContentTypography className="bg-background min-h-screen">
      {children}
      <Toaster />
    </ContentTypography>
  );
}
