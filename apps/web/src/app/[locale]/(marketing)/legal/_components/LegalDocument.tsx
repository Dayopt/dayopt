import { Link } from '@dayopt/i18n/navigation';
import type { Locale } from '@dayopt/i18n/routing';
import design from '@web/components/content/ContentDesign.module.css';
import { EditorialHeader } from '@web/components/content/EditorialHeader';
import { getTranslations } from 'next-intl/server';
import { MDXRemote } from 'next-mdx-remote/rsc';

import { getLegalDocument, type LegalDocumentSlug } from '../_lib/legal-content';
import { legalMdxComponents } from './legal-mdx-components';
import { LEGAL_MDX_OPTIONS } from './legal-mdx-options';
import {
  getLegalReviewWarningItemKeys,
  shouldShowLegalReviewWarning,
} from './legal-review-warning';

interface LegalDocumentProps {
  locale: Locale;
  slug: LegalDocumentSlug;
}

interface LegalReviewWarningContent {
  title: string;
  description: string;
  items: string[];
}

async function getReviewWarning(
  locale: Locale,
  slug: LegalDocumentSlug,
): Promise<LegalReviewWarningContent | null> {
  if (!shouldShowLegalReviewWarning(process.env.NODE_ENV, slug)) {
    return null;
  }

  const t = await getTranslations({ locale, namespace: 'legal.reviewWarning' });
  return {
    title: t('title'),
    description: t('description'),
    items: getLegalReviewWarningItemKeys(slug).map((key) => t(`items.${key}`)),
  };
}

function LegalReviewWarning({
  content,
  compact,
}: {
  content: LegalReviewWarningContent;
  compact: boolean;
}) {
  const className = compact
    ? 'bg-muted border-destructive mt-8 rounded-2xl border-2 p-6'
    : 'bg-muted border-destructive mt-12 rounded-2xl border-2 p-6';

  return (
    <div className={className} data-legal-review-warning>
      <div className="flex items-start gap-4">
        <span className="text-2xl">⚠️</span>
        <div>
          <p className="text-destructive font-medium">{content.title}</p>
          <p className="text-muted-foreground mt-1 text-sm">{content.description}</p>
          <ul className="text-muted-foreground mt-2 list-inside list-disc text-sm">
            {content.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export async function LegalDocument({ locale, slug }: LegalDocumentProps) {
  const { frontMatter, content } = getLegalDocument(locale, slug);
  const reviewWarning = await getReviewWarning(locale, slug);
  const isSecurity = slug === 'security';
  const t = await getTranslations({ locale });
  const navigation = ['terms', 'privacy', 'cookies', 'tokushoho', 'security'] as const;

  return (
    <section className={design.page}>
      <EditorialHeader
        eyebrow={t('common.contentDesign.legal')}
        title={frontMatter.title}
        description={frontMatter.description}
      >
        <p className={design.articleMeta}>{frontMatter.lastUpdated}</p>
      </EditorialHeader>
      <div className={design.legalGrid}>
        <nav className={design.legalNav} aria-label={t('footer.sections.legal')}>
          {navigation.map((destination) => (
            <Link
              key={destination}
              href={`/legal/${destination}`}
              aria-current={destination === slug ? 'page' : undefined}
            >
              {getLegalDocument(locale, destination).frontMatter.title}
            </Link>
          ))}
        </nav>
        <div className={design.articleBody}>
          <MDXRemote source={content} components={legalMdxComponents} options={LEGAL_MDX_OPTIONS} />

          {reviewWarning ? (
            <LegalReviewWarning content={reviewWarning} compact={slug === 'tokushoho'} />
          ) : null}

          {isSecurity ? (
            <div className="text-muted-foreground mt-8 text-center text-sm">
              <p>{frontMatter.lastUpdated}</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
