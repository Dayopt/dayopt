import { Link } from '@dayopt/i18n/navigation';
import { routing } from '@dayopt/i18n/routing';
import design from '@web/components/content/ContentDesign.module.css';
import { EditorialHeader } from '@web/components/content/EditorialHeader';
import { generateSEOMetadata } from '@web/platform/seo/metadata';
import { ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import dynamic from 'next/dynamic';

const ContactForm = dynamic(
  () => import('./contact-form').then((mod) => ({ default: mod.ContactForm })),
  {
    loading: () => (
      <div className="space-y-6">
        <div className="bg-muted animate-shimmer h-10 w-full rounded-lg" />
        <div className="bg-muted animate-shimmer h-10 w-full rounded-lg" />
        <div className="bg-muted animate-shimmer h-32 w-full rounded-lg" />
        <div className="bg-muted animate-shimmer h-10 w-32 rounded-lg" />
      </div>
    ),
  },
);

interface PageProps {
  params: Promise<{ locale: string }>;
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// ISR: マーケティングページは1時間ごとに再検証
export const revalidate = 3600;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketing' });

  return generateSEOMetadata({
    title: t('contact.title'),
    description: t('contact.subtitle'),
    url: `/${locale}/contact`,
    locale: locale,
    keywords:
      locale === 'ja'
        ? ['お問い合わせ', 'サポート', 'ヘルプ', '質問', 'カスタマーサービス']
        : ['contact', 'support', 'help', 'inquiry', 'customer service'],
    type: 'website',
  });
}

export default async function ContactPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'marketing' });
  const tc = await getTranslations({ locale, namespace: 'common' });

  return (
    <section className={design.page}>
      <EditorialHeader
        eyebrow={tc('contentDesign.support')}
        title={t('contact.title')}
        description={t('contact.subtitle')}
        artwork
      />
      <div className={design.contactGrid}>
        <aside className={design.contactAside}>
          <p>{tc('contentDesign.contactNote')}</p>
          <p className="mt-8">{tc('contentDesign.contactHelp')}</p>
          <Link href="/docs">
            {tc('navigation.docs')}
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
          <Link href="/docs/faq">
            {tc('contentDesign.faq')}
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </aside>
        <div className={design.contactForm}>
          <ContactForm />
        </div>
      </div>
    </section>
  );
}
