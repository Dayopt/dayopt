import { Link } from '@dayopt/i18n/navigation';
import type { ReactNode } from 'react';

import { readLegalText, readLegalTree, type LegalContentTree } from './legal-content-tree';
import { LegalContactCard } from './legal-standard-document';

const COOKIE_CATEGORIES = ['essential', 'analytics', 'preference', 'marketing'] as const;
const COOKIE_ITEMS = [
  'supabaseAuth',
  'nextLocale',
  'theme',
  'cookieConsent',
  'vercelAnalytics',
  'posthog',
  'turnstile',
] as const;

function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-2xl font-medium">{title}</h2>
      {children}
    </section>
  );
}

export function CookieDocument({ data }: { data: LegalContentTree }) {
  const sections = readLegalTree(data, 'sections');
  const categories = readLegalTree(sections, 'categories');
  const specificCookies = readLegalTree(sections, 'specificCookies');
  const thirdParty = readLegalTree(sections, 'thirdParty');
  const manageCookies = readLegalTree(sections, 'manageCookies');

  return (
    <div className="space-y-8">
      <LegalSection title={readLegalText(sections, 'introduction', 'title')}>
        <p className="text-foreground leading-relaxed">
          {readLegalText(sections, 'introduction', 'content')}
        </p>
      </LegalSection>

      <LegalSection title={readLegalText(sections, 'whatAreCookies', 'title')}>
        <p className="text-foreground leading-relaxed">
          {readLegalText(sections, 'whatAreCookies', 'content')}
        </p>
      </LegalSection>

      <LegalSection title={readLegalText(categories, 'title')}>
        <div className="space-y-6">
          {COOKIE_CATEGORIES.map((categoryKey) => {
            const category = readLegalTree(categories, categoryKey);
            return (
              <div key={categoryKey}>
                <h3 className="text-foreground mb-2 text-lg font-medium">
                  {readLegalText(category, 'name')}
                </h3>
                <p className="text-foreground mb-2 leading-relaxed">
                  {readLegalText(category, 'description')}
                </p>
                <p className="text-muted-foreground text-sm">
                  {readLegalText(category, categoryKey === 'marketing' ? 'note' : 'examples')}
                </p>
              </div>
            );
          })}
        </div>
      </LegalSection>

      <LegalSection title={readLegalText(specificCookies, 'title')}>
        <div className="bg-card border-border-subtle overflow-hidden rounded-2xl border shadow-sm">
          <table className="w-full">
            <thead>
              <tr className="bg-container border-border border-b">
                {[
                  'headerName',
                  'headerProvider',
                  'headerPurpose',
                  'headerCategory',
                  'headerDuration',
                ].map((header) => (
                  <th
                    key={header}
                    className="text-foreground px-6 py-4 text-left text-sm font-medium"
                  >
                    {readLegalText(specificCookies, header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {COOKIE_ITEMS.map((itemKey) => {
                const item = readLegalTree(specificCookies, itemKey);
                return (
                  <tr key={itemKey}>
                    <td className="text-foreground px-6 py-4 text-sm font-medium">
                      {readLegalText(item, 'name')}
                    </td>
                    {['provider', 'purpose', 'category', 'duration'].map((field) => (
                      <td key={field} className="text-foreground px-6 py-4 text-sm">
                        {readLegalText(item, field)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </LegalSection>

      <LegalSection title={readLegalText(thirdParty, 'title')}>
        <p className="text-foreground mb-4 leading-relaxed">
          {readLegalText(thirdParty, 'content')}
        </p>
        <ul className="text-foreground list-inside list-disc space-y-2 leading-relaxed">
          {['vercel', 'sentry', 'turnstile'].map((key) => (
            <li key={key}>{readLegalText(thirdParty, key)}</li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-4 text-sm">{readLegalText(thirdParty, 'note')}</p>
      </LegalSection>

      <LegalSection title={readLegalText(manageCookies, 'title')}>
        <p className="text-foreground mb-4 leading-relaxed">
          {readLegalText(manageCookies, 'intro')}
        </p>
        <ul className="text-foreground list-inside list-disc space-y-2 leading-relaxed">
          {['chrome', 'firefox', 'safari', 'edge'].map((key) => (
            <li key={key}>{readLegalText(manageCookies, key)}</li>
          ))}
        </ul>
      </LegalSection>

      {['impact', 'doNotTrack', 'changes'].map((sectionKey) => (
        <LegalSection key={sectionKey} title={readLegalText(sections, sectionKey, 'title')}>
          <p className="text-foreground leading-relaxed">
            {readLegalText(sections, sectionKey, 'content')}
          </p>
        </LegalSection>
      ))}

      <LegalSection title={readLegalText(sections, 'contact', 'title')}>
        <p className="text-foreground mb-4 leading-relaxed">
          {readLegalText(sections, 'contact', 'content')}
        </p>
        <LegalContactCard data={data} />
      </LegalSection>

      <section>
        <p className="text-foreground leading-relaxed">
          <Link href="/legal/privacy" className="text-primary underline hover:no-underline">
            {readLegalText(data, 'privacyLinkLabel')}
          </Link>
        </p>
      </section>
    </div>
  );
}
