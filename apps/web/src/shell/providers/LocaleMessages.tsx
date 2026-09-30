import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';

/** Only routes with client-translated content load the message formatter. */
export async function LocaleMessages({ children }: { children: React.ReactNode }) {
  const messages = await getMessages();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- exclude server-only namespaces
  const { footer, legal, ossCredits, marketing, ...sharedMessages } = messages;
  return (
    <NextIntlClientProvider
      messages={{ ...sharedMessages, marketing: { contact: marketing.contact } }}
    >
      {children}
    </NextIntlClientProvider>
  );
}
