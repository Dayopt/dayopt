import { Footer } from '@web/shell/layout/Footer';
import { Header } from '@web/shell/layout/Header';
import { LocaleMessages } from '@web/shell/providers/LocaleMessages';
import { setRequestLocale } from 'next-intl/server';

interface MarketingLayoutProps {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

export default async function MarketingLayout({ children, params }: MarketingLayoutProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <LocaleMessages>
      <div className="flex min-h-screen flex-col">
        <Header />
        <main id="main-content" role="main" className="flex-1">
          {children}
        </main>
        <Footer />
      </div>
    </LocaleMessages>
  );
}
