// @vitest-environment happy-dom
/**
 * 法務文書（privacy/terms/cookies/tokushoho/security × en/ja）の変更検知契約。
 *
 * 旧 apps/web/src/test/e2e/i18n-smoke.spec.ts の `legal pages` describe を移設したもの
 * （2026-08 CI monorepo Phase 5, issue #1815）。「本文が勝手に変わっていないこと」を守る
 * のが目的で、ブラウザを起動せず getLegalDocument / generateMetadata /
 * legalMdxComponents という本番と同一の部品を直接 Vitest 上で実行して検証する。
 *
 * **MDX のコンパイル経路だけは本番と異なる。** 本番の LegalDocument.tsx は
 * `next-mdx-remote/rsc`（Server Component 経路）を使うが、Vitest で RSC は描画できない
 * ため、ここでは同じ LEGAL_MDX_OPTIONS を渡した `serialize` + 非 RSC の MDXRemote を使う。
 * 両経路の出力が一致することは、移設元の Playwright（実ブラウザ = 本番経路）が持っていた
 * hash / 見出し数 / href の期待値と byte 一致することで確認した。**legal component に
 * RSC 固有の機能（async component、server-only import）を持ち込むとこの前提が崩れ、
 * テストは通るのに本番の出力だけが変わる**ため、その時はテスト側の経路も見直すこと。
 *
 * MDX ソースはプレーンな Markdown ではなく `<XxxDocument data={{...}} />` という
 * JSX props（object literal）で本文を持つため、見出し数・table・list の構造は
 * MDX テキストの静的パース（正規表現等）だけでは再現できず、実際に
 * `_components/legal-*-document.tsx` のレイアウト定義（例: legal-standard-document.tsx の
 * PRIVACY_SECTIONS/TERMS_SECTIONS）を通して初めて決まる。そのため本テストは
 * 「MDX 本文のみの hash」ではなく「実際にレンダリングした結果」を hash / 計測する。
 *
 * **Link の mock について（写経であり実装ではないことに注意）。**
 * `@dayopt/i18n/navigation` の Link（next-intl の createNavigation 経由）は
 * locale に応じて href に `/ja` 等のプレフィックスを付与する（en は as-needed で無プレフィックス）。
 * 本来はこの本物の Link を `NextIntlClientProvider` でラップして描画するのが最も忠実だが、
 * この Vitest 環境では next-intl/navigation の内部 import（`next/navigation`）が
 * ワークスペース内の next バージョン重複解決（next@16.2.11 と next@16.3.0 が併存）により
 * `Cannot find module '.../node_modules/next/navigation'` で解決できず断念した
 * （2026-08、issue #1815 レビューで検証。next-intl 側は拡張子なしで `next/navigation` を
 * import しており、apps/web が直接使う next@16.2.11 側とは別に peer 解決された
 * next@16.3.0 側のコピーで解決に失敗する。vitest.config.ts 側の resolve 設定変更が必要で
 * このテストの scope を超えるため、mock によるロジック写経を選んだ）。
 * そのため below の `localizeHref` で `applyPathnamePrefix` 相当のロジックを手で再現している。
 * **この写経が本番の next-intl 実装からズレたら検知できない**のが limitation。
 * `LOCALE_PREFIX` が `'as-needed'` でなくなった場合は明示的に throw するので、
 * その時点でこの関数と routing 設定のずれが顕在化する（サイレントな乖離は防ぐ）。
 * 写経元:
 * - `isLocalizableHref` / `prefixPathname`: next-intl/dist/esm/development/navigation/shared/utils.js
 * - `applyPathnamePrefix` / `getLocaleAsPrefix`: next-intl/dist/esm/development/shared/utils.js
 *
 * `<h1>` / frontmatter description は LegalDocument.tsx がそのまま描画するだけで、
 * どちらも metadata contract（`generateMetadata` の title/description）が同じ値を検証済みのため
 * 別途の検証は追加しない。一方 `lastUpdated`（LegalDocument.tsx:89）は metadata にも hash にも
 * 現れない（hash 対象は MDXRemote の出力のみで、`<h1>` 周辺の frontmatter 表示を含まない）ため、
 * `LEGAL_CONTRACT_CASES.lastUpdated` として独立に検証する。hash に混ぜないのは、
 * 落ちた時に「本文が変わった」のか「日付だけ変わった」のかを区別できるようにするため。
 */
import { DEFAULT_LOCALE, LOCALE_PREFIX } from '@dayopt/config';
import { cleanup, render } from '@testing-library/react';
import { MDXRemote } from 'next-mdx-remote';
import { serialize } from 'next-mdx-remote/serialize';
import { createHash } from 'node:crypto';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { legalMdxComponents } from './_components/legal-mdx-components';
import { LEGAL_MDX_OPTIONS } from './_components/legal-mdx-options';
import { getLegalDocument, type LegalDocumentSlug } from './_lib/legal-content';
import { generateMetadata as generateCookiesMetadata } from './cookies/page';
import { generateMetadata as generatePrivacyMetadata } from './privacy/page';
import { generateMetadata as generateSecurityMetadata } from './security/page';
import { generateMetadata as generateTermsMetadata } from './terms/page';
import { generateMetadata as generateTokushohoMetadata } from './tokushoho/page';

// vi.mock ファクトリからは outer const/let を直接参照できないため、mutable な現在 locale は
// vi.hoisted で作る（Vitest 公式パターン）。値は各 it() の先頭で同期的に設定してから render()
// するので、同一ファイル内でテストが直列実行される前提（このファイルは describe.concurrent 等を
// 使っていない）でレースは起きない。
const linkLocaleRef = vi.hoisted(() => ({ current: 'en' as 'en' | 'ja' }));

vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={localizeHref(href, linkLocaleRef.current)} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * next-intl の Link/getPathname が行う locale prefix 付与の写経。ファイル冒頭のコメント参照。
 * function 宣言にしているのは、vi.mock ファクトリから参照する際に巻き上げの制約に触れないため
 * （const のアロー関数だと "cannot access before initialization" 相当の Vitest 制約に触れうる）。
 */
function localizeHref(href: string, locale: 'en' | 'ja'): string {
  if (LOCALE_PREFIX !== 'as-needed') {
    throw new Error(
      `localizeHref は @dayopt/config の LOCALE_PREFIX === 'as-needed' を前提にした写経です（実際: ${LOCALE_PREFIX}）。routing 設定が変わったのでこの関数を更新してください。`,
    );
  }
  // next-intl の isLocalizableHref: プロトコル付き（mailto: / https: 等）や相対パスは対象外
  const hasProtocol = /^[a-z]+:/i.test(href);
  const isLocalizable = href.startsWith('/') && !hasProtocol;
  if (!isLocalizable || locale === DEFAULT_LOCALE) return href;

  const prefix = `/${locale}`;
  const normalizedHref = /^\/(\?.*)?$/.test(href) ? href.slice(1) : href;
  return `${prefix}${normalizedHref}`;
}

const GENERATE_METADATA: Record<LegalDocumentSlug, typeof generatePrivacyMetadata> = {
  privacy: generatePrivacyMetadata,
  terms: generateTermsMetadata,
  cookies: generateCookiesMetadata,
  tokushoho: generateTokushohoMetadata,
  security: generateSecurityMetadata,
};

interface LegalContractCase {
  locale: 'en' | 'ja';
  slug: LegalDocumentSlug;
  metadataTitle: string;
  metadataDescription: string;
  /**
   * frontMatter.lastUpdated（LegalDocument.tsx:89 が描画）。metadata（title/description）にも
   * body hash（MDXRemote 出力のみが対象で、この文字列は含まない）にも現れないため独立に検証する。
   */
  lastUpdated: string;
  /** sha256(レンダリング後 body の textContent)。本文が1文字でも変わると落ちる。 */
  bodyHash: string;
  hrefs: readonly (string | null)[];
  counts: { h2: number; h3: number; tables: number; lists: number };
}

const LEGAL_CONTRACT_CASES: readonly LegalContractCase[] = [
  {
    locale: 'en',
    slug: 'privacy',
    metadataTitle: 'Privacy Policy - Dayopt',
    metadataDescription: 'How Dayopt handles your personal information',
    lastUpdated: 'Last Updated: 2026-09-08',
    bodyHash: '2a90476b67b302dd0cdac0fc3d96e4b145bbf55d783e2dc1b61d32886de0c6f2',
    hrefs: ['/legal/cookies'],
    counts: { h2: 20, h3: 0, tables: 0, lists: 16 },
  },
  {
    locale: 'en',
    slug: 'terms',
    metadataTitle: 'Terms of Service - Dayopt',
    metadataDescription: 'Our terms and conditions for using the Dayopt service',
    lastUpdated: 'Last Updated: 2026-09-08',
    bodyHash: '1af6bad3a553dd38484d80854d88f97fdc8290f98784b36b482f30063b763f61',
    hrefs: ['/legal/refund'],
    counts: { h2: 20, h3: 0, tables: 0, lists: 15 },
  },
  {
    locale: 'en',
    slug: 'cookies',
    metadataTitle: 'Cookie Policy - Dayopt',
    metadataDescription: 'How Dayopt uses cookies and similar technologies',
    lastUpdated: 'Last Updated: 2026-07-17',
    bodyHash: 'b113bd6e71ca4bbbe3be13fb30d9c7fff808e4ecc73b10b2090e1199b3db0490',
    hrefs: ['/legal/privacy'],
    counts: { h2: 10, h3: 4, tables: 1, lists: 2 },
  },
  {
    locale: 'en',
    slug: 'tokushoho',
    metadataTitle: 'Specified Commercial Transactions Act - Dayopt',
    metadataDescription:
      'Information required under the Act on Specified Commercial Transactions (Japan)',
    lastUpdated: 'Last Updated: 2025-12-07',
    bodyHash: 'a2f763a39d7f99d256a65c32d9da611f9928e30ab5701964ff1291382ab5101a',
    hrefs: [],
    counts: { h2: 0, h3: 0, tables: 1, lists: 4 },
  },
  {
    locale: 'en',
    slug: 'security',
    metadataTitle: 'Security - Dayopt',
    metadataDescription:
      'Dayopt implements the highest standards of security to protect your information.',
    lastUpdated: 'Last Updated: October 15, 2025',
    bodyHash: '0713c3984851d02dbb5fbffa54cd6d5867c6963a01b2eb56fdbf1a037d08d40e',
    hrefs: [
      'mailto:security@dayopt.app',
      'https://github.com/Dayopt/dayopt/security/advisories/new',
      'https://github.com/Dayopt/dayopt/blob/main/docs/legal/SECURITY.md',
      'https://github.com/Dayopt/dayopt/blob/main/docs/legal/VULNERABILITY_DISCLOSURE.md',
      'https://github.com/Dayopt/dayopt/blob/main/docs/legal/INCIDENT_RESPONSE.md',
      '/legal/privacy',
      'mailto:security@dayopt.app',
      'mailto:support@dayopt.app',
    ],
    counts: { h2: 5, h3: 10, tables: 2, lists: 5 },
  },
  {
    locale: 'ja',
    slug: 'privacy',
    metadataTitle: 'プライバシーポリシー - Dayopt',
    metadataDescription: 'Dayoptにおける個人情報の取り扱いについて',
    lastUpdated: '最終更新日: 2026-09-08',
    bodyHash: 'cc3221d7b3b883284042d7cf88212ba8d68b7ab5798fda27c8a2f8499baf6c79',
    // PrivacyDocument の Link は @dayopt/i18n/navigation 経由（localizeHref 対象）。
    // as-needed prefix により ja は /ja が付く。
    hrefs: ['/ja/legal/cookies'],
    counts: { h2: 20, h3: 0, tables: 0, lists: 16 },
  },
  {
    locale: 'ja',
    slug: 'terms',
    metadataTitle: '利用規約 - Dayopt',
    metadataDescription: 'Dayoptサービスの利用に関する規約',
    lastUpdated: '最終更新日: 2026-09-08',
    bodyHash: '384d3aa40eeca9cdd9be83b92029b91280e5239432815b09b2dff0fbd6b47661',
    hrefs: ['/ja/legal/refund'],
    counts: { h2: 20, h3: 0, tables: 0, lists: 15 },
  },
  {
    locale: 'ja',
    slug: 'cookies',
    metadataTitle: 'Cookieポリシー - Dayopt',
    metadataDescription: 'Dayoptにおけるクッキーおよび類似技術の使用について',
    lastUpdated: '最終更新日: 2026-07-17',
    bodyHash: '59c4ccd3399f7cf02b2139e46a7977bd1a535b9053892b3d054f82fe4da3b871',
    hrefs: ['/ja/legal/privacy'],
    counts: { h2: 10, h3: 4, tables: 1, lists: 2 },
  },
  {
    locale: 'ja',
    slug: 'tokushoho',
    metadataTitle: '特定商取引法に基づく表記 - Dayopt',
    metadataDescription: '特定商取引法に基づく通信販売業者の表示義務に関する情報',
    lastUpdated: '最終更新日: 2025-12-07',
    bodyHash: 'b872197d12c3fc8a15833e13d45e11b35a09fb6d1319c7200f2a09f2cf48771f',
    hrefs: [],
    counts: { h2: 0, h3: 0, tables: 1, lists: 4 },
  },
  {
    locale: 'ja',
    slug: 'security',
    metadataTitle: 'セキュリティ - Dayopt',
    metadataDescription:
      'Dayoptは、ユーザーの皆様の情報を保護するために、最高水準のセキュリティ対策を実施しています。',
    lastUpdated: '最終更新日: 2025-10-15',
    bodyHash: '7ccba2a1c8e3e578d3840f36e0a1f61c09c211f2aa01100a026ed33bf167fca7',
    hrefs: [
      'mailto:security@dayopt.app',
      'https://github.com/Dayopt/dayopt/security/advisories/new',
      'https://github.com/Dayopt/dayopt/blob/main/docs/legal/SECURITY.md',
      'https://github.com/Dayopt/dayopt/blob/main/docs/legal/VULNERABILITY_DISCLOSURE.md',
      'https://github.com/Dayopt/dayopt/blob/main/docs/legal/INCIDENT_RESPONSE.md',
      '/ja/legal/privacy',
      'mailto:security@dayopt.app',
      'mailto:support@dayopt.app',
    ],
    counts: { h2: 5, h3: 10, tables: 2, lists: 5 },
  },
];

afterEach(() => {
  cleanup();
});

describe('legal document contract', () => {
  for (const testCase of LEGAL_CONTRACT_CASES) {
    it(`${testCase.locale}/${testCase.slug} の metadata と本文構造を維持する`, async () => {
      const metadata = await GENERATE_METADATA[testCase.slug]({
        params: Promise.resolve({ locale: testCase.locale }),
      });
      expect(metadata.title).toBe(testCase.metadataTitle);
      expect(metadata.description).toBe(testCase.metadataDescription);

      const document = getLegalDocument(testCase.locale, testCase.slug);
      // LegalDocument.tsx:89 相当。metadata にも body hash にも現れないので独立に検証する。
      expect(document.frontMatter.lastUpdated).toBe(testCase.lastUpdated);

      // Link mock（localizeHref）が参照する現在 locale をセットしてから render する。
      linkLocaleRef.current = testCase.locale;
      const compiled = await serialize(document.content, LEGAL_MDX_OPTIONS);
      const { container } = render(<MDXRemote {...compiled} components={legalMdxComponents} />);

      const bodyText = (container as HTMLElement).textContent ?? '';
      expect(createHash('sha256').update(bodyText).digest('hex')).toBe(testCase.bodyHash);

      const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) =>
        anchor.getAttribute('href'),
      );
      expect(hrefs).toEqual(testCase.hrefs);

      expect({
        h2: container.querySelectorAll('h2').length,
        h3: container.querySelectorAll('h3').length,
        tables: container.querySelectorAll('table').length,
        lists: container.querySelectorAll('ul, ol').length,
      }).toEqual(testCase.counts);
    });
  }
});
