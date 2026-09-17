import { dayoptContact, dayoptUrls } from '@dayopt/config';
import { Link } from '@dayopt/i18n/navigation';

import { readLegalText, readLegalTree, type LegalContentTree } from './legal-content-tree';

type StandardDocumentKind = 'privacy' | 'terms';

type SectionBlock =
  | { type: 'paragraph'; key: string; position?: 'before' | 'after' }
  | { type: 'list'; keys: readonly string[] }
  | { type: 'note'; key: string }
  | { type: 'support-contact'; prefixKey: string; suffixKey: string }
  | { type: 'link'; labelKey: string; href?: string; hrefKey?: string }
  | { type: 'contact' }
  | { type: 'table'; columns: readonly string[]; rows: readonly string[] };

interface SectionLayout {
  key: string;
  blocks: readonly SectionBlock[];
}

function getParagraphClassName(position: 'before' | 'after' | undefined): string {
  if (position === 'before') {
    return 'text-foreground mb-4 leading-relaxed';
  }
  if (position === 'after') {
    return 'text-foreground mt-4 leading-relaxed';
  }
  return 'text-foreground leading-relaxed';
}

const PRIVACY_SECTIONS: readonly SectionLayout[] = [
  { key: 'introduction', blocks: [{ type: 'paragraph', key: 'content' }] },
  {
    key: 'dataCollection',
    blocks: [
      {
        type: 'list',
        keys: ['accountInfo', 'usageData', 'billing', 'contactData', 'technicalData', 'cookies'],
      },
    ],
  },
  {
    key: 'purposes',
    blocks: [{ type: 'list', keys: ['service', 'support', 'security', 'analytics', 'legal'] }],
  },
  {
    key: 'providers',
    blocks: [
      { type: 'paragraph', key: 'intro', position: 'after' },
      {
        type: 'list',
        keys: [
          'supabase',
          'vercel',
          'sentry',
          'stripe',
          'resend',
          'upstash',
          'cloudflare',
          'google',
          'axiom',
        ],
      },
      { type: 'paragraph', key: 'changes', position: 'after' },
    ],
  },
  {
    key: 'transfers',
    blocks: [
      { type: 'paragraph', key: 'content', position: 'after' },
      { type: 'paragraph', key: 'safeguards', position: 'after' },
    ],
  },
  {
    key: 'googleCalendar',
    blocks: [
      { type: 'paragraph', key: 'intro', position: 'after' },
      { type: 'list', keys: ['access', 'content', 'window', 'disconnect', 'deletion'] },
      { type: 'paragraph', key: 'limitedUse', position: 'after' },
      {
        type: 'link',
        labelKey: 'policyLink',
        href: 'https://developers.google.com/terms/api-services-user-data-policy',
      },
    ],
  },
  {
    key: 'externalConnections',
    blocks: [
      { type: 'paragraph', key: 'content', position: 'after' },
      { type: 'list', keys: ['access', 'revoke'] },
      { type: 'paragraph', key: 'review', position: 'after' },
    ],
  },
  {
    key: 'retention',
    blocks: [
      { type: 'paragraph', key: 'intro', position: 'after' },
      {
        type: 'table',
        columns: ['category', 'period'],
        rows: ['primary', 'google', 'technical', 'backup', 'providers', 'billing'],
      },
      { type: 'paragraph', key: 'note', position: 'after' },
    ],
  },
  {
    key: 'rights',
    blocks: [
      { type: 'paragraph', key: 'content', position: 'after' },
      { type: 'list', keys: ['export', 'consent', 'california', 'children'] },
      { type: 'link', labelKey: 'policyLink', href: '/legal/cookies' },
    ],
  },
  {
    key: 'security',
    blocks: [
      { type: 'paragraph', key: 'content', position: 'after' },
      { type: 'paragraph', key: 'breach', position: 'after' },
      { type: 'paragraph', key: 'changes', position: 'after' },
      { type: 'link', labelKey: 'policyLink', href: '/legal/security' },
    ],
  },
];

const TERMS_SECTIONS: readonly SectionLayout[] = [
  { key: 'introduction', blocks: [{ type: 'paragraph', key: 'content' }] },
  { key: 'serviceDescription', blocks: [{ type: 'paragraph', key: 'content' }] },
  {
    key: 'accountRegistration',
    blocks: [{ type: 'list', keys: ['requirements', 'responsibility', 'age'] }],
  },
  { key: 'acceptableUse', blocks: [{ type: 'paragraph', key: 'content' }] },
  {
    key: 'dataOwnership',
    blocks: [{ type: 'list', keys: ['ownership', 'export', 'termination'] }],
  },
  { key: 'externalConnections', blocks: [{ type: 'paragraph', key: 'content' }] },
  {
    key: 'subscriptionPlans',
    blocks: [
      { type: 'paragraph', key: 'intro', position: 'after' },
      { type: 'list', keys: ['trial', 'paid', 'expiry', 'changes'] },
    ],
  },
  { key: 'serviceLevel', blocks: [{ type: 'paragraph', key: 'content' }] },
  { key: 'limitationOfLiability', blocks: [{ type: 'paragraph', key: 'content' }] },
  {
    key: 'cancellation',
    blocks: [
      { type: 'paragraph', key: 'summary', position: 'after' },
      { type: 'link', labelKey: 'details', hrefKey: 'detailsLink' },
    ],
  },
  { key: 'termination', blocks: [{ type: 'paragraph', key: 'content' }] },
  { key: 'modifications', blocks: [{ type: 'paragraph', key: 'content' }] },
  { key: 'governingLaw', blocks: [{ type: 'paragraph', key: 'content' }] },
  {
    key: 'contact',
    blocks: [{ type: 'paragraph', key: 'content', position: 'after' }, { type: 'contact' }],
  },
];

export function LegalContactCard({ data }: { data: LegalContentTree }) {
  return (
    <div className="bg-container rounded-2xl p-4">
      <p className="text-foreground">
        <strong>{readLegalText(data, 'contactLabels', 'email')}:</strong>{' '}
        {dayoptContact.supportEmail}
      </p>
      <p className="text-foreground">
        <strong>{readLegalText(data, 'contactLabels', 'website')}:</strong> {dayoptUrls.marketing}
      </p>
    </div>
  );
}

function StandardLegalDocument({
  data,
  kind,
}: {
  data: LegalContentTree;
  kind: StandardDocumentKind;
}) {
  const sections = kind === 'privacy' ? PRIVACY_SECTIONS : TERMS_SECTIONS;

  return (
    <div className="space-y-8">
      {sections.map((layout) => {
        const section = readLegalTree(data, 'sections', layout.key);

        return (
          <section key={layout.key}>
            <h2 className="mb-4 text-2xl font-medium">{readLegalText(section, 'title')}</h2>
            {layout.blocks.map((block) => {
              const blockKey = `${layout.key}-${block.type}-${'key' in block ? block.key : 'body'}`;

              switch (block.type) {
                case 'paragraph':
                  return (
                    <p key={blockKey} className={getParagraphClassName(block.position)}>
                      {readLegalText(section, block.key)}
                    </p>
                  );
                case 'list':
                  return (
                    <ul
                      key={blockKey}
                      className="text-foreground list-inside list-disc space-y-2 leading-relaxed"
                    >
                      {block.keys.map((key) => (
                        <li key={key}>{readLegalText(section, key)}</li>
                      ))}
                    </ul>
                  );
                case 'note':
                  return (
                    <p key={blockKey} className="text-muted-foreground mt-4 text-sm">
                      {readLegalText(section, block.key)}
                    </p>
                  );
                case 'support-contact':
                  return (
                    <p key={blockKey} className="text-muted-foreground mt-4 text-sm">
                      {readLegalText(section, block.prefixKey)}
                      {dayoptContact.supportEmail}
                      {readLegalText(section, block.suffixKey)}
                    </p>
                  );
                case 'link':
                  return (
                    <p key={blockKey} className="text-foreground mt-4 leading-relaxed">
                      <Link
                        href={block.href ?? readLegalText(section, block.hrefKey ?? '')}
                        className="text-primary underline hover:no-underline"
                      >
                        {readLegalText(section, block.labelKey)}
                      </Link>
                    </p>
                  );
                case 'table':
                  return (
                    <div key={blockKey} className="overflow-x-auto">
                      <table className="border-border w-full border text-left text-sm">
                        <caption className="sr-only">{readLegalText(section, 'title')}</caption>
                        <thead>
                          <tr>
                            {block.columns.map((column) => (
                              <th key={column} scope="col" className="border-border border p-4">
                                {readLegalText(section, 'columns', column)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {block.rows.map((row) => (
                            <tr key={row}>
                              {block.columns.map((column, index) =>
                                index === 0 ? (
                                  <th
                                    key={column}
                                    scope="row"
                                    className="border-border border p-4 align-top font-medium"
                                  >
                                    {readLegalText(section, 'rows', row, column)}
                                  </th>
                                ) : (
                                  <td key={column} className="border-border border p-4 align-top">
                                    {readLegalText(section, 'rows', row, column)}
                                  </td>
                                ),
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                case 'contact':
                  return <LegalContactCard key={blockKey} data={data} />;
              }
            })}
          </section>
        );
      })}
    </div>
  );
}

export function PrivacyDocument({ data }: { data: LegalContentTree }) {
  return <StandardLegalDocument data={data} kind="privacy" />;
}

export function TermsDocument({ data }: { data: LegalContentTree }) {
  return <StandardLegalDocument data={data} kind="terms" />;
}
