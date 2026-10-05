import { Heading, Text } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import { routing } from '@dayopt/i18n/routing';
import { DocArticle } from '@web/features/docs';
import { getMDXContentForRSC } from '@web/lib/mdx';
import { generateSEOMetadata } from '@web/platform/seo/metadata';
import { generateDocsNavigation } from '@web/shell/navigation';
import { FileText } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// ISR: ドキュメントは1日ごとに再検証
export const revalidate = 86400;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;

  // はじめに（getting-started）の Overview が無いロケールはフォールバック表示と同じメタデータにする
  const overview = await getMDXContentForRSC('getting-started', locale);
  if (overview) {
    return generateSEOMetadata({
      title: overview.frontMatter.title,
      description: overview.frontMatter.description,
      url: `/${locale}/docs`,
      locale: locale,
      type: 'article',
      category: 'docs',
    });
  }

  const t = await getTranslations({ locale, namespace: 'common' });
  return generateSEOMetadata({
    title: t('navigation.docs'),
    description: t('navigation.docsDescription'),
    url: `/${locale}/docs`,
    locale: locale,
    keywords:
      locale === 'ja'
        ? ['ドキュメント', 'API', 'ガイド', 'チュートリアル', 'SaaS', '開発']
        : ['documentation', 'API', 'guides', 'tutorials', 'SaaS', 'development'],
    type: 'website',
    category: 'docs',
  });
}

export default async function DocsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  // /docs はデフォルトで「はじめに」の Overview（getting-started/index.mdx）を表示する。
  // ロケールにコンテンツが無い場合（未翻訳など）は従来のセクション一覧にフォールバックする。
  const overview = await getMDXContentForRSC('getting-started', locale);

  if (overview) {
    return <DocArticle category="getting-started" mdxContent={overview.content} />;
  }

  const tCommon = await getTranslations({ locale, namespace: 'common' });
  const tDocs = await getTranslations({ locale, namespace: 'docs' });

  const navigation = await generateDocsNavigation(locale);

  return (
    <div className="space-y-12 px-6 py-8 lg:px-8">
      <div className="mx-auto max-w-3xl space-y-12">
        {/* Header Section */}
        <div className="space-y-4">
          <Heading as="h1" size="4xl" className="text-foreground">
            {tCommon('navigation.docs')}
          </Heading>
          <Text size="xl" variant="muted" className="max-w-3xl">
            {tDocs('landing.subtitle')}
          </Text>
        </div>

        {/* ドキュメント一覧 */}
        <div className="space-y-8">
          {navigation.map((section) => (
            <div key={section.title}>
              <Heading as="h2" size="xl" className="text-foreground mb-4">
                {section.title}
              </Heading>
              <div className="divide-border divide-y">
                {section.items.map((item) =>
                  item.href ? (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="hover:bg-state-hover flex items-center gap-4 py-3 transition-colors"
                    >
                      <FileText className="text-muted-foreground size-4 shrink-0" />
                      <span className="text-foreground text-sm">{item.title}</span>
                    </Link>
                  ) : null,
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
