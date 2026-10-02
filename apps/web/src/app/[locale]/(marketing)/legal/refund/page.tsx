import { Link } from '@dayopt/i18n/navigation';
import type { Locale } from '@dayopt/i18n/routing';
import design from '@web/components/content/ContentDesign.module.css';
import { EditorialHeader } from '@web/components/content/EditorialHeader';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

// ISR: 法的ページは1日ごとに再検証
export const revalidate = 86400;

/**
 * メタデータ生成（SEO対策・i18n対応）
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale?: Locale }>;
}): Promise<Metadata> {
  const { locale = 'en' } = await params;
  const t = await getTranslations({ locale });

  return {
    title: `${t('legal.refund.title')} - Dayopt`,
    description: t('legal.refund.description'),
  };
}

interface PageProps {
  params: Promise<{ locale?: Locale }>;
}

/**
 * 返金・解約ポリシーページ（Server Component）
 */
export default async function RefundPolicyPage({ params }: PageProps) {
  const { locale = 'en' } = await params;
  const t = await getTranslations({ locale });

  const lastUpdated = '2026-03-17';

  return (
    <div className={design.page}>
      {/* ヘッダー */}
      <EditorialHeader
        eyebrow={t('common.contentDesign.legal')}
        title={t('legal.refund.title')}
        description={t('legal.refund.description')}
      >
        <p className={design.articleMeta}>
          {t('legal.lastUpdated')}: {lastUpdated}
        </p>
      </EditorialHeader>

      {/* コンテンツ */}
      <div className={`${design.articleBody} space-y-8`}>
        {/* 1. 解約ポリシー */}
        <section>
          <h2 className="mb-4 text-2xl font-medium">
            {t('legal.refund.sections.cancellation.title')}
          </h2>
          <ul className="text-foreground list-inside list-disc space-y-2 leading-relaxed">
            <li>{t('legal.refund.sections.cancellation.anytime')}</li>
            <li>{t('legal.refund.sections.cancellation.access')}</li>
            <li>{t('legal.refund.sections.cancellation.noDowngrade')}</li>
          </ul>
        </section>

        {/* 2. 返金ポリシー */}
        <section>
          <h2 className="mb-4 text-2xl font-medium">{t('legal.refund.sections.refund.title')}</h2>
          <ul className="text-foreground list-inside list-disc space-y-2 leading-relaxed">
            <li>{t('legal.refund.sections.refund.general')}</li>
            <li>{t('legal.refund.sections.refund.exception')}</li>
            <li>{t('legal.refund.sections.refund.request')}</li>
          </ul>
        </section>

        {/* 3. 無料トライアル */}
        <section>
          <h2 className="mb-4 text-2xl font-medium">
            {t('legal.refund.sections.freeTrial.title')}
          </h2>
          <p className="text-foreground leading-relaxed">
            {t('legal.refund.sections.freeTrial.content')}
          </p>
        </section>

        {/* 4. 解約方法 */}
        <section>
          <h2 className="mb-4 text-2xl font-medium">
            {t('legal.refund.sections.howToCancel.title')}
          </h2>
          <ol className="text-foreground list-inside list-decimal space-y-2 leading-relaxed">
            <li>{t('legal.refund.sections.howToCancel.step1')}</li>
            <li>{t('legal.refund.sections.howToCancel.step2')}</li>
            <li>{t('legal.refund.sections.howToCancel.step3')}</li>
            <li>{t('legal.refund.sections.howToCancel.step4')}</li>
          </ol>
          <p className="text-muted-foreground mt-4 text-sm">
            {t('legal.refund.sections.howToCancel.note')}
          </p>
        </section>

        {/* 5. お問い合わせ */}
        <section>
          <h2 className="mb-4 text-2xl font-medium">{t('legal.refund.sections.contact.title')}</h2>
          <p className="text-foreground mb-4 leading-relaxed">
            {t('legal.refund.sections.contact.content')}
          </p>
          <div className="bg-container rounded-2xl p-4">
            <p className="text-foreground">
              <strong>Email:</strong> {t('legal.contact.email')}
            </p>
            <p className="text-foreground">
              <strong>Website:</strong> {t('legal.contact.website')}
            </p>
          </div>
        </section>
      </div>

      {/* 関連リンク */}
      <div className="bg-muted mt-12 rounded-2xl p-6">
        <p className="text-muted-foreground text-sm">
          <Link href="/legal/terms" className="text-foreground underline hover:no-underline">
            {t('legal.navigation.terms')}
          </Link>
          {' | '}
          <Link href="/legal/privacy" className="text-foreground underline hover:no-underline">
            {t('legal.navigation.privacy')}
          </Link>
        </p>
      </div>
    </div>
  );
}
