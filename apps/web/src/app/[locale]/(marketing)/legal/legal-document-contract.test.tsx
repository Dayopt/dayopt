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
import { DEFAULT_LOCALE, LOCALE_PREFIX, dayoptContact } from '@dayopt/config';
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

const GENERATE_METADATA = {
  privacy: generatePrivacyMetadata,
  terms: generateTermsMetadata,
  cookies: generateCookiesMetadata,
  tokushoho: generateTokushohoMetadata,
  security: generateSecurityMetadata,
} satisfies Record<LegalDocumentSlug, typeof generatePrivacyMetadata>;

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
    lastUpdated: 'Review draft: 2026-09-25',
    bodyHash: '669c587b6aa8979b4f9b5295feb8275ebab65724d78f8902d9c25abb3083b2c5',
    hrefs: [
      'https://developers.google.com/terms/api-services-user-data-policy',
      '/legal/cookies',
      '/legal/security',
    ],
    counts: {
      h2: 10,
      h3: 0,
      tables: 1,
      lists: 6,
    },
  },
  {
    locale: 'en',
    slug: 'terms',
    metadataTitle: 'Terms of Service - Dayopt',
    metadataDescription: 'Our terms and conditions for using the Dayopt service',
    lastUpdated: 'Review draft: 2026-09-17',
    bodyHash: 'ec49aace33ea3661a6e93e9110f868121419d6625765c9de90e32b8169eafd3a',
    hrefs: ['/legal/refund'],
    counts: {
      h2: 14,
      h3: 0,
      tables: 0,
      lists: 3,
    },
  },
  {
    locale: 'en',
    slug: 'cookies',
    metadataTitle: 'Cookie Policy - Dayopt',
    metadataDescription: 'How Dayopt uses cookies and similar technologies',
    lastUpdated: 'Review draft: 2026-09-25',
    bodyHash: '20e009b46e4a23b48a1dcb3df8614921673da3f4c2cef206aff072a81b322b37',
    hrefs: ['/legal/privacy'],
    counts: {
      h2: 10,
      h3: 4,
      tables: 1,
      lists: 2,
    },
  },
  {
    locale: 'en',
    slug: 'tokushoho',
    metadataTitle: 'Specified Commercial Transactions Act - Dayopt',
    metadataDescription:
      'Information required under the Act on Specified Commercial Transactions (Japan)',
    lastUpdated: 'Review draft: 2026-09-17',
    bodyHash: '1fdd92bd6747897f66863da146cf4af3cb60651f7b5cfbf5070117ebacf3d58c',
    hrefs: [],
    counts: {
      h2: 0,
      h3: 0,
      tables: 1,
      lists: 4,
    },
  },
  {
    locale: 'en',
    slug: 'security',
    metadataTitle: 'Security - Dayopt',
    metadataDescription: 'Security practices and vulnerability reporting for Dayopt',
    lastUpdated: 'Review draft: 2026-09-17',
    bodyHash: 'cb1983ca9111de056a00141afaf9a20d36f96555485046a7f2f4d39d0e553089',
    hrefs: [
      'mailto:security@dayopt.app',
      '/legal/privacy',
      'mailto:security@dayopt.app',
      'mailto:support@dayopt.app',
    ],
    counts: {
      h2: 5,
      h3: 7,
      tables: 1,
      lists: 5,
    },
  },
  {
    locale: 'ja',
    slug: 'privacy',
    metadataTitle: 'プライバシーポリシー - Dayopt',
    metadataDescription: 'Dayoptにおける個人情報の取り扱いについて',
    lastUpdated: 'レビュー原稿: 2026-09-25',
    bodyHash: 'b4cc3018705fb30991a6def1bae6b5d7155624b9fbd30421283846046f164b39',
    hrefs: [
      'https://developers.google.com/terms/api-services-user-data-policy',
      '/ja/legal/cookies',
      '/ja/legal/security',
    ],
    counts: {
      h2: 10,
      h3: 0,
      tables: 1,
      lists: 6,
    },
  },
  {
    locale: 'ja',
    slug: 'terms',
    metadataTitle: '利用規約 - Dayopt',
    metadataDescription: 'Dayoptサービスの利用に関する規約',
    lastUpdated: 'レビュー原稿: 2026-09-17',
    bodyHash: '5c139e107917d19d8f8dac26b6634314044e4a163595766533d980a5679d93b2',
    hrefs: ['/ja/legal/refund'],
    counts: {
      h2: 14,
      h3: 0,
      tables: 0,
      lists: 3,
    },
  },
  {
    locale: 'ja',
    slug: 'cookies',
    metadataTitle: 'Cookieポリシー - Dayopt',
    metadataDescription: 'Dayoptにおけるクッキーおよび類似技術の使用について',
    lastUpdated: 'レビュー原稿: 2026-09-25',
    bodyHash: '000b4f314d0609306a072711000766a796204def62043d2c6335070075fb5964',
    hrefs: ['/ja/legal/privacy'],
    counts: {
      h2: 10,
      h3: 4,
      tables: 1,
      lists: 2,
    },
  },
  {
    locale: 'ja',
    slug: 'tokushoho',
    metadataTitle: '特定商取引法に基づく表記 - Dayopt',
    metadataDescription: '特定商取引法に基づく通信販売業者の表示義務に関する情報',
    lastUpdated: 'レビュー原稿: 2026-09-17',
    bodyHash: '448b42103e9b29f050e743b727913de2cec2c22db6c42a657ff9d5f5960fb340',
    hrefs: [],
    counts: {
      h2: 0,
      h3: 0,
      tables: 1,
      lists: 4,
    },
  },
  {
    locale: 'ja',
    slug: 'security',
    metadataTitle: 'セキュリティ - Dayopt',
    metadataDescription: 'Dayoptの安全管理と脆弱性の報告窓口',
    lastUpdated: 'レビュー原稿: 2026-09-17',
    bodyHash: '1e9875fcf3585aad130447705ef108c1003e37351424b662256a4a7a0da43574',
    hrefs: [
      'mailto:security@dayopt.app',
      '/ja/legal/privacy',
      'mailto:security@dayopt.app',
      'mailto:support@dayopt.app',
    ],
    counts: {
      h2: 5,
      h3: 7,
      tables: 1,
      lists: 5,
    },
  },
];

afterEach(() => {
  cleanup();
});

/**
 * 公開 legal ページが Dayopt のリポジトリへリンクしてはいけない。リポジトリは private 化する
 * （2026-09-14 決定）ため、外部の閲覧者・セキュリティ研究者からは 404 になり、特に脆弱性の
 * 報告窓口が黙って塞がる。報告窓口はリポジトリの公開設定に依存しないメールに限る。
 */
const DAYOPT_REPOSITORY_URL_PATTERN = /github\.com\/Dayopt\//i;

async function renderLegalBody(testCase: LegalContractCase): Promise<HTMLElement> {
  const document = getLegalDocument(testCase.locale, testCase.slug);
  // Link mock（localizeHref）が参照する現在 locale をセットしてから render する。
  linkLocaleRef.current = testCase.locale;
  const compiled = await serialize(document.content, LEGAL_MDX_OPTIONS);
  const { container } = render(<MDXRemote {...compiled} components={legalMdxComponents} />);
  return container as HTMLElement;
}

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

      const container = await renderLegalBody(testCase);

      const bodyText = container.textContent ?? '';
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

describe('legal document repository visibility independence', () => {
  for (const testCase of LEGAL_CONTRACT_CASES) {
    it(`${testCase.locale}/${testCase.slug} は Dayopt のリポジトリへリンクしない`, async () => {
      const container = await renderLegalBody(testCase);
      const hrefs = Array.from(container.querySelectorAll('a')).map(
        (anchor) => anchor.getAttribute('href') ?? '',
      );
      expect(hrefs.filter((href) => DAYOPT_REPOSITORY_URL_PATTERN.test(href))).toEqual([]);
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

      // mailto を含む最初の section が「脆弱性の報告」。その中のリンクは security メールだけ
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

describe('legal review factual boundaries', () => {
  for (const testCase of LEGAL_CONTRACT_CASES) {
    it(`${testCase.locale}/${testCase.slug} に未提供機能の保証を再導入しない`, async () => {
      const container = await renderLegalBody(testCase);
      expect(container.textContent).not.toMatch(
        /BYOK|30 AI interactions|AI interactions per month|Prisma|99\.9%|100GB|1GB|energy mapping|エネルギーマッピング|月.{0,3}30回/,
      );
      if (testCase.slug === 'privacy') {
        expect(container.querySelectorAll('table')).toHaveLength(1);
        expect(container.textContent).toMatch(/MCP/);
        expect(container.textContent).toMatch(/R2/);
        expect(container.textContent).toMatch(/support@dayopt.app/);
        expect(container.textContent).not.toMatch(
          /at least 30 days to export|削除後30日間.*エクスポート/,
        );
      }
      if (testCase.slug === 'terms') {
        expect(container.textContent).toMatch(/45/);
        expect(container.textContent).toMatch(/\$5/);
        expect(container.textContent).toMatch(/does not automatically charge|自動課金されません/);
      }
    });
  }
});
