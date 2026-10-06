import { routing } from '@dayopt/i18n/routing';
import { ErrorLayout } from '@web/components/errors/ErrorLayout';
import { generateSEOMetadata } from '@web/platform/seo/metadata';
import { getLocale, getTranslations } from 'next-intl/server';

export const metadata = generateSEOMetadata({
  title: 'Page Not Found - 404 Error',
  description:
    'The page you are looking for could not be found. Return to our homepage or browse our available content.',
  url: '/404',
  noindex: true,
});

export default async function NotFound() {
  const requestedLocale = await getLocale();
  const locale = requestedLocale === 'ja' ? 'ja' : routing.defaultLocale;
  const t = await getTranslations({ locale });
  return (
    <ErrorLayout
      locale={locale}
      code="404"
      title={t('errors.notFound.title')}
      description={t('errors.notFound.description')}
      backToHomeLabel={t('errors.notFound.goHome')}
      contactLabel={t('common.navigation.contact')}
      docsLabel={t('common.navigation.docs')}
    />
  );
}
