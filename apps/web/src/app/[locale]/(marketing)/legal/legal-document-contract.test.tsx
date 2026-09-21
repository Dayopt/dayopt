// @vitest-environment happy-dom
/**
 * LegalDocument の公開安全境界を、本文のコピーそのものとは分離して検証する。
 * コピー・見出し数・内部リンクの一覧は人間の法務レビューで確認する対象であり、
 * 固定 hash にすると意図した改訂までテスト修正を要求するため、このテストでは扱わない。
 */
import { dayoptContact } from '@dayopt/config';
import { cleanup, render } from '@testing-library/react';
import { MDXRemote } from 'next-mdx-remote';
import { serialize } from 'next-mdx-remote/serialize';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { legalMdxComponents } from './_components/legal-mdx-components';
import { LEGAL_MDX_OPTIONS } from './_components/legal-mdx-options';
import { getLegalDocument, type LegalDocumentSlug } from './_lib/legal-content';

vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

interface LegalContractCase {
  locale: 'en' | 'ja';
  slug: LegalDocumentSlug;
  lastUpdated: string;
}

const LEGAL_CONTRACT_CASES: readonly LegalContractCase[] = [
  { locale: 'en', slug: 'privacy', lastUpdated: 'Last Updated: 2026-08-17' },
  { locale: 'en', slug: 'terms', lastUpdated: 'Last Updated: 2026-03-23' },
  { locale: 'en', slug: 'cookies', lastUpdated: 'Last Updated: 2026-07-17' },
  { locale: 'en', slug: 'tokushoho', lastUpdated: 'Last Updated: 2025-12-07' },
  { locale: 'en', slug: 'security', lastUpdated: 'Last Updated: September 14, 2026' },
  { locale: 'ja', slug: 'privacy', lastUpdated: '最終更新日: 2026-08-17' },
  { locale: 'ja', slug: 'terms', lastUpdated: '最終更新日: 2026-03-23' },
  { locale: 'ja', slug: 'cookies', lastUpdated: '最終更新日: 2026-07-17' },
  { locale: 'ja', slug: 'tokushoho', lastUpdated: '最終更新日: 2025-12-07' },
  { locale: 'ja', slug: 'security', lastUpdated: '最終更新日: 2026-09-14' },
];

afterEach(() => {
  cleanup();
});

const DAYOPT_REPOSITORY_URL_PATTERN = /github\.com\/Dayopt\//i;

async function renderLegalBody(testCase: LegalContractCase): Promise<HTMLElement> {
  const document = getLegalDocument(testCase.locale, testCase.slug);
  const compiled = await serialize(document.content, LEGAL_MDX_OPTIONS);
  const { container } = render(<MDXRemote {...compiled} components={legalMdxComponents} />);
  return container as HTMLElement;
}

describe('legal document contract', () => {
  for (const testCase of LEGAL_CONTRACT_CASES) {
    it(`${testCase.locale}/${testCase.slug} は安全設定で compile でき、更新日を表示する`, async () => {
      const document = getLegalDocument(testCase.locale, testCase.slug);
      expect(document.frontMatter.lastUpdated).toBe(testCase.lastUpdated);

      const container = await renderLegalBody(testCase);
      expect(container.textContent).toBeTruthy();

      const hrefs = Array.from(container.querySelectorAll('a')).map(
        (anchor) => anchor.getAttribute('href') ?? '',
      );
      expect(hrefs.some((href) => DAYOPT_REPOSITORY_URL_PATTERN.test(href))).toBe(false);
      expect(container.textContent ?? '').not.toMatch(/GitHub Security Advisory/i);
    });
  }

  for (const locale of ['en', 'ja'] as const) {
    it(`${locale}/security の脆弱性報告窓口は security メールである`, async () => {
      const testCase = LEGAL_CONTRACT_CASES.find(
        (candidate) => candidate.locale === locale && candidate.slug === 'security',
      );
      if (!testCase) throw new Error(`security contract case が無い: ${locale}`);

      const container = await renderLegalBody(testCase);
      const reportSection = Array.from(container.querySelectorAll('section')).find((section) =>
        section.querySelector('a[href^="mailto:"]'),
      );
      if (!reportSection) throw new Error('mailto を含む section が無い');

      const reportLinks = Array.from(reportSection.querySelectorAll('a')).map((anchor) =>
        anchor.getAttribute('href'),
      );
      expect(reportLinks).toEqual([`mailto:${dayoptContact.securityEmail}`]);
    });
  }
});
