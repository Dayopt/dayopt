import { Footer } from '@web/shell/layout/Footer';
import { Header } from '@web/shell/layout/Header';
import { setRequestLocale } from 'next-intl/server';

export default async function LandingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main id="main-content" role="main" className="flex-1">
        {children}
      </main>
      <Footer />
    </div>
  );
}
