import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { defineConfig } from 'vitest/config';
const dirname =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const STORYBOOK_CONFIG_DIR = path.join(dirname, '../storybook/.storybook');
const STORYBOOK_ROOT = path.dirname(STORYBOOK_CONFIG_DIR);

// ─── unit test の環境分割（node / happy-dom）─────────────────────────
//
// 全 test に happy-dom を掛けると、**実行時間の大半が環境構築とモジュール読み込みに
// 消える**。CI 実測（308 files）では tests 15.2s に対し environment 85.4s / import
// 123.0s / setup 45.3s で、テスト本体は全体の 5% しかなかった。実際に DOM が要るのは
// 約 1/4 のファイルだけなので、既定を `node` にして DOM が要るものだけ opt-in する。
//
// 判定は 2 段:
//   1. `.tsx` — component / hook を render するので DOM 必須
//   2. `use*.test.ts` — React hook の test は renderHook を使うので DOM 必須
// この 2 つで大半が拾える。残りは DOM_ONLY_TESTS に明示列挙する。
//
// **新しく DOM が要る test を足した時**: 上の 2 パターンに当てはまらなければ
// DOM_ONLY_TESTS に追加する。逆に純ロジックの test を DOM 側に置いても
// 遅くなるだけで壊れない。
//
// ── 分類を間違えた時にどこで気づくか（2026-08-05 に実際に踏んだ）──────
//
// **正しい oracle は CI（Node 24）であって、ローカルではない。** Node 22 以降は
// `localStorage` をネイティブに持つため、`environment: 'node'` でも web storage が
// 使えてしまい、**ローカルでは通るのに CI で `ReferenceError: localStorage is not
// defined` になる**。分類を変えた時はローカルの pass を根拠にしないこと。
//
// **DOM 依存は test ファイルを読んでも分からないことがある。** 下の
// `calendarScrollStore.test.ts` は localStorage に一言も触れていないが、
// **実装側**（`calendarScrollStore.ts`）が localStorage を使う。test の中身を
// grep する方式では原理的に拾えないので、迷ったら DOM 側に置く。

/** `.tsx` でも `use*.test.ts` でもないが DOM が要る test。 */
const DOM_ONLY_TESTS = [
  // 実装（calendarScrollStore.ts）が localStorage で永続化する
  'src/features/calendar/stores/calendarScrollStore.test.ts',
  'src/features/timeblock/components/editor/TimeblockRecordActions.test.ts',
  'src/lib/cookie-consent.test.ts',
  'src/lib/keyboard/shortcut-registry.test.ts',
  // 別タブからの storage.clear() まで見る consent lifecycle の test（browser 前提）
  'instrumentation-client.test.ts',
];

/** DOM を必要とする test の include パターン。 */
const DOM_TEST_PATTERNS = ['**/*.{test,spec}.tsx', '**/use*.{test,spec}.ts', ...DOM_ONLY_TESTS];

/** 全 unit project 共通の exclude。 */
const UNIT_EXCLUDE = [
  'node_modules',
  'dist',
  '.next',
  'cypress',
  'compass',
  '**/e2e/**',
  '**/integration/**',
];

/** unit project 共通設定（環境と setup だけが node / dom で違う）。 */
const UNIT_SHARED = {
  globals: true,
  css: true,
  server: {
    deps: {
      // next-intl が ESM で next/navigation を拡張子なしで import し解決失敗する問題を回避
      inline: ['next-intl'],
    },
  },
} as const;

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  plugins: [react()],
  test: {
    // istanbul: Node.js（unit）とブラウザ（storybook）の両方で動作
    coverage: {
      provider: 'istanbul',
      reportOnFailure: true,
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'src/lib/test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        '**/*.stories.{ts,tsx}',
        'dist/',
        '.next/',
        'cypress/',
        'compass/',
        '.storybook/',
      ],
      // ローカルで見る時は pnpm test:coverage（unit と unit-dom の両方を回す）
    },
    projects: [
      // ユニットテスト・DOM 不要（node）— 全 unit test の約 3/4 がここに入る
      {
        extends: true,
        test: {
          ...UNIT_SHARED,
          name: 'unit',
          environment: 'node',
          setupFiles: ['./src/lib/test/setup-node.ts'],
          include: ['**/*.{test,spec}.ts', '*.test.mjs'],
          exclude: [...UNIT_EXCLUDE, ...DOM_TEST_PATTERNS],
        },
      },
      // ユニットテスト・DOM 必要（happy-dom）
      {
        extends: true,
        test: {
          ...UNIT_SHARED,
          name: 'unit-dom',
          environment: 'happy-dom',
          setupFiles: ['./src/lib/test/setup.ts'],
          include: DOM_TEST_PATTERNS,
          exclude: UNIT_EXCLUDE,
        },
      },
      // Storybook テスト（ブラウザ: Playwright chromium）
      //
      // `root` は configDir の親（apps/storybook）に揃える（#2592）。addon-vitest は stories glob を
      // `test.root ?? process.cwd()`（= apps/product）基準の相対 include に直す一方、project の実 root は
      // Storybook の viteFinal が返す apps/storybook になる。基準がずれると `../../product/src/**` だけが
      // `src/**` に潰れて apps/storybook/src を探し、product の Story が 1 件も collect されない
      // （web / packages は apps/* 兄弟の偶然で通っていた）。`test.include` は plugin が破棄するので使えない。
      {
        extends: true,
        plugins: [
          storybookTest({
            configDir: STORYBOOK_CONFIG_DIR,
            storybookScript: 'pnpm --filter @dayopt/storybook storybook -- --no-open',
            tags: {
              exclude: ['docs-only', 'wip'],
            },
          }),
        ],
        test: {
          name: 'storybook',
          root: STORYBOOK_ROOT,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [
              {
                browser: 'chromium',
              },
            ],
          },
          setupFiles: [path.join(dirname, 'src/lib/test/storybook-setup.ts')],
        },
      },
      // Storybook Dark mode テスト（decorator と ThemeContext に同じ theme を渡す）
      {
        extends: true,
        plugins: [
          storybookTest({
            configDir: STORYBOOK_CONFIG_DIR,
            storybookScript: 'pnpm --filter @dayopt/storybook storybook -- --no-open',
            tags: {
              exclude: ['docs-only', 'wip'],
            },
          }),
        ],
        test: {
          name: 'storybook-dark',
          root: STORYBOOK_ROOT,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [
              {
                browser: 'chromium',
              },
            ],
          },
          setupFiles: [path.join(dirname, 'src/lib/test/storybook-setup-dark.ts')],
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@dayopt/storybook': path.resolve(__dirname, '../storybook/.storybook'),
      // next-intl が ESM で next/navigation を拡張子なしで import する問題を回避
      'next/navigation': path.resolve(__dirname, './node_modules/next/navigation.js'),
    },
  },
});
