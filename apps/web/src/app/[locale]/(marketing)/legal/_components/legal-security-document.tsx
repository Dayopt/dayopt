import { dayoptContact } from '@dayopt/config';
import { Link } from '@dayopt/i18n/navigation';
import { AlertTriangle, FileText, Lock, Mail, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { readLegalText, readLegalTree, type LegalContentTree } from './legal-content-tree';

function SectionHeading({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <Icon className="text-primary size-6" />
      <h2 className="text-2xl font-medium">{children}</h2>
    </div>
  );
}

function SecurityTableCell({ children }: { children: ReactNode }) {
  return <td className="border-border border p-4">{children}</td>;
}

export function SecurityDocument({ data }: { data: LegalContentTree }) {
  const policy = readLegalTree(data, 'policy');
  const supportedVersions = readLegalTree(policy, 'supportedVersions');
  const measures = readLegalTree(policy, 'measures');
  const vulnerability = readLegalTree(data, 'vulnerability');
  const contacts = readLegalTree(vulnerability, 'contacts');
  const includeInfo = readLegalTree(vulnerability, 'includeInfo');
  const timeline = readLegalTree(vulnerability, 'timeline');
  const disclosure = readLegalTree(data, 'disclosure');
  const safeHarbor = readLegalTree(disclosure, 'safeHarbor');
  const relatedDocs = readLegalTree(data, 'relatedDocs');
  const contact = readLegalTree(data, 'contact');

  return (
    <>
      <section className="mb-12">
        <SectionHeading icon={Lock}>{readLegalText(policy, 'title')}</SectionHeading>

        <div className="bg-container mb-6 rounded-2xl p-6">
          <h3 className="mb-4 text-lg font-medium">{readLegalText(supportedVersions, 'title')}</h3>
          <table className="border-border w-full border">
            <thead className="bg-container">
              <tr>
                <th className="border-border border p-4 text-left">
                  {readLegalText(supportedVersions, 'version')}
                </th>
                <th className="border-border border p-4 text-left">
                  {readLegalText(supportedVersions, 'status')}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <SecurityTableCell>{readLegalText(supportedVersions, 'v1')}</SecurityTableCell>
                <SecurityTableCell>
                  {readLegalText(supportedVersions, 'v1Status')}
                </SecurityTableCell>
              </tr>
              <tr>
                <SecurityTableCell>{readLegalText(supportedVersions, 'v0')}</SecurityTableCell>
                <SecurityTableCell>
                  {readLegalText(supportedVersions, 'v0Status')}
                </SecurityTableCell>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="prose dark:prose-invert max-w-none">
          <h3 className="text-lg font-medium">{readLegalText(measures, 'title')}</h3>
          <ul className="space-y-2">
            {[
              'transportEncryption',
              'mfa',
              'rateLimit',
              'sqlInjection',
              'xss',
              'csrf',
              'dependencies',
              'monitoring',
            ].map((key) => (
              <li key={key}>{readLegalText(measures, key)}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mb-12">
        <SectionHeading icon={AlertTriangle}>
          {readLegalText(vulnerability, 'title')}
        </SectionHeading>

        <div className="bg-muted mb-6 rounded-2xl p-6">
          <p className="text-destructive-foreground mb-4 font-medium">
            {readLegalText(vulnerability, 'warning', 'title')}
          </p>
          <p className="text-muted-foreground text-sm">
            {readLegalText(vulnerability, 'warning', 'description')}
          </p>
        </div>

        <div className="prose dark:prose-invert max-w-none">
          <h3 className="text-lg font-medium">{readLegalText(contacts, 'title')}</h3>
          <p>{readLegalText(contacts, 'description')}</p>
          <ul className="space-y-2">
            <li className="flex items-center gap-2">
              <Mail className="size-4" />
              <strong>{readLegalText(contacts, 'email')}</strong>:{' '}
              <a
                href={`mailto:${dayoptContact.securityEmail}`}
                className="text-primary hover:underline"
              >
                {dayoptContact.securityEmail}
              </a>
            </li>
          </ul>

          <h3 className="mt-6 text-lg font-medium">{readLegalText(includeInfo, 'title')}</h3>
          <ul className="space-y-2">
            {['type', 'affectedVersions', 'steps', 'poc', 'impact', 'fix'].map((key) => (
              <li key={key}>{readLegalText(includeInfo, key)}</li>
            ))}
          </ul>

          <h3 className="mt-6 text-lg font-medium">{readLegalText(timeline, 'title')}</h3>
          <table className="border-border w-full border">
            <thead className="bg-container">
              <tr>
                {['severity', 'initialResponse', 'fixRelease'].map((key) => (
                  <th key={key} className="border-border border p-4 text-left">
                    {readLegalText(timeline, key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['critical', 'criticalResponse', 'criticalFix'],
                  ['high', 'highResponse', 'highFix'],
                  ['medium', 'mediumResponse', 'mediumFix'],
                  ['low', 'lowResponse', 'lowFix'],
                ] as const
              ).map(([severity, response, fix]) => (
                <tr key={severity}>
                  <SecurityTableCell>{readLegalText(timeline, severity)}</SecurityTableCell>
                  <SecurityTableCell>{readLegalText(timeline, response)}</SecurityTableCell>
                  <SecurityTableCell>{readLegalText(timeline, fix)}</SecurityTableCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="mb-4 text-2xl font-medium">{readLegalText(disclosure, 'title')}</h2>

        <div className="bg-container rounded-2xl p-6">
          <h3 className="mb-4 text-lg font-medium">{readLegalText(safeHarbor, 'title')}</h3>
          <p className="text-foreground mb-4 leading-relaxed">
            {readLegalText(safeHarbor, 'description')}
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="text-success mb-2 font-medium">
                {readLegalText(safeHarbor, 'allowed', 'title')}
              </h4>
              <ul className="text-muted-foreground space-y-1 text-sm">
                {['ownAccount', 'research', 'poc'].map((key) => (
                  <li key={key}>{readLegalText(safeHarbor, 'allowed', key)}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-destructive mb-2 font-medium">
                {readLegalText(safeHarbor, 'prohibited', 'title')}
              </h4>
              <ul className="text-muted-foreground space-y-1 text-sm">
                {['dos', 'dataAccess', 'disclosure'].map((key) => (
                  <li key={key}>{readLegalText(safeHarbor, 'prohibited', key)}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <SectionHeading icon={FileText}>{readLegalText(relatedDocs, 'title')}</SectionHeading>

        {/*
         * 報告窓口・関連ドキュメントに GitHub リポジトリへのリンクを置かない。リポジトリを
         * private にすると外部の研究者から辿れなくなるため（2026-09-14）。窓口はメールだけにする。
         */}
        <div className="grid gap-4 md:grid-cols-2">
          <Link
            href="/legal/privacy"
            className="border-border hover:border-primary block rounded-2xl border p-4 transition-colors"
          >
            <h3 className="mb-2 font-medium">
              {readLegalText(relatedDocs, 'privacyPolicy', 'title')}
            </h3>
            <p className="text-muted-foreground text-sm">
              {readLegalText(relatedDocs, 'privacyPolicy', 'description')}
            </p>
          </Link>
        </div>
      </section>

      <section className="bg-container rounded-2xl p-6">
        <h2 className="mb-4 text-xl font-medium">{readLegalText(contact, 'title')}</h2>
        <div className="space-y-2">
          <p className="flex items-center gap-2">
            <Mail className="size-4" />
            <strong>{readLegalText(contact, 'securityTeam')}</strong>:{' '}
            <a
              href={`mailto:${dayoptContact.securityEmail}`}
              className="text-primary hover:underline"
            >
              {dayoptContact.securityEmail}
            </a>
          </p>
          <p className="flex items-center gap-2">
            <Mail className="size-4" />
            <strong>{readLegalText(contact, 'general')}</strong>:{' '}
            <a
              href={`mailto:${dayoptContact.supportEmail}`}
              className="text-primary hover:underline"
            >
              {dayoptContact.supportEmail}
            </a>
          </p>
        </div>

        <p className="text-muted-foreground mt-4 text-sm">{readLegalText(contact, 'thankYou')}</p>
      </section>
    </>
  );
}
