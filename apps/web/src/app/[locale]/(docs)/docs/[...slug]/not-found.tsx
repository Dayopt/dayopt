'use client';

import { Button } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import design from '@web/components/content/ContentDesign.module.css';
import { EditorialHeader } from '@web/components/content/EditorialHeader';
import { useTranslations } from 'next-intl';

// Client Component にしている理由:
// この boundary で next-intl の server API（getTranslations / getLocale）を使うと、
// locale 解決のために request を読む可能性を Next が検出し、docs/[slug] 全体が
// 動的レンダリングへ降格する（記事ページが SSG されなくなる）。
// 文言は [locale]/layout.tsx の NextIntlClientProvider から client 側で取る。
export default function NotFound() {
  const t = useTranslations('errors');

  return (
    <div className={design.page}>
      <EditorialHeader
        eyebrow="404"
        title={t('notFound.title')}
        description={t('notFound.description')}
        artwork
      >
        <Button asChild className="mt-8">
          <Link href="/">{t('notFound.goHome')}</Link>
        </Button>
      </EditorialHeader>
    </div>
  );
}
