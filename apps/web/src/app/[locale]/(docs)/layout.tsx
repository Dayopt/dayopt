import { LocaleMessages } from '@web/shell/providers/LocaleMessages';
import { setRequestLocale } from 'next-intl/server';

export default async function DocsLocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <LocaleMessages>{children}</LocaleMessages>;
}
