// Dayopt ESLint - Next.js 16 Flat Config
// @see https://nextjs.org/docs/app/api-reference/config/eslint

import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import storybook from 'eslint-plugin-storybook';
import tailwindcss from 'eslint-plugin-tailwindcss';
import { defineConfig, globalIgnores } from 'eslint/config';

const eslintConfig = defineConfig([
  // Next.js公式推奨設定（React, React Hooks, Core Web Vitals）
  ...nextVitals,
  // TypeScript推奨ルール
  ...nextTs,

  // 未使用の eslint-disable ディレクティブを error 扱いにする（再発防止）
  // 対象ルールが発火しなくなった disable は CI で fail させ、stale な disable の蓄積を防ぐ
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },

  // Ignore patterns
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'dist/**',
    'coverage/**',
    'storybook-static/**',
    'next-env.d.ts',
    // CLI scripts (console.log is expected)
    'scripts/**',
    'src/lib/i18n/scripts/**',
    'src/lib/styles/scripts/**',
  ]),

  // Tailwind CSS: 任意値(arbitrary value)の使用を警告
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: { tailwindcss },
    settings: {
      tailwindcss: {
        config: {},
      },
    },
    rules: {
      'tailwindcss/no-arbitrary-value': 'warn',
    },
  },

  // Storybook: Story の装飾サイズ（h-[500px] 等）は UI 品質に無関係のため除外
  {
    files: ['**/*.stories.{ts,tsx}', '**/story-helpers.{ts,tsx}'],
    rules: {
      'tailwindcss/no-arbitrary-value': 'off',
    },
  },

  // union の switch の網羅検査（型情報を使う）。正本: docs/engineering/conventions.md §正本と派生
  // tsconfig.json の exclude と同じ範囲を外す（project service が型情報を得られないため）。
  {
    files: ['src/**/*.{ts,tsx}'],
    // `.well-known` は tsconfig の `**/*.ts` に一致せず（ドットで始まるディレクトリ）、型情報が無い。
    ignores: [
      'src/lib/test/integration/**',
      'src/lib/test/storybook-setup*.ts',
      'src/app/.well-known/**',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false },
      ],
    },
  },

  // TypeScript用カスタムルール
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // any型禁止（CLAUDE.md準拠）
      '@typescript-eslint/no-explicit-any': 'error',
      // console.log禁止（warn/errorは許可）
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // React 19.2 の新しい react-hooks ルール
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
      // 空のインターフェースは type alias で代替可能だが既存コードに多いため warn
      '@typescript-eslint/no-empty-object-type': 'warn',
      // no-unused-vars は以前の設定では未有効。段階的に有効化する
      // TypeScript自体が未使用importを検出し、Prettierが自動削除するため低優先
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // 客観的に判定できる a11y 欠落はコードレビューではなく CI で止める。
  // Story / test は意図的にラベルを省略した fixture を含むため対象外。
  {
    files: ['src/**/*.{jsx,tsx}'],
    ignores: ['**/*.test.{jsx,tsx}', '**/*.spec.{jsx,tsx}', '**/*.stories.{jsx,tsx}'],
    rules: {
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/control-has-associated-label': [
        'error',
        {
          controlComponents: ['Button'],
          // table cell 自体は interactive control ではなく、列見出しで名前が決まる。
          ignoreElements: ['td'],
          depth: 5,
        },
      ],

      // --- 以下 recommended 相当（2026-09-04 追加）---
      // 有効化前に calendar 配下だけで 15 件、apps/product 全体で 27 件の違反があった。
      // 「マウスでしか押せない div」「role を名乗るがキー操作が無い要素」は
      // レビューで見落とされ続けるため、prose ではなく機械で止める。
      // 意図的な例外は各行の eslint-disable に理由を書く（ファイル単位で無効化しない）。
      'jsx-a11y/anchor-has-content': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/aria-activedescendant-has-tabindex': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/heading-has-content': 'error',
      'jsx-a11y/html-has-lang': 'error',
      'jsx-a11y/iframe-has-title': 'error',
      'jsx-a11y/img-redundant-alt': 'error',
      'jsx-a11y/interactive-supports-focus': [
        'error',
        {
          tabbable: ['button', 'checkbox', 'link', 'searchbox', 'spinbutton', 'switch', 'textbox'],
        },
      ],
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/media-has-caption': 'error',
      'jsx-a11y/mouse-events-have-key-events': 'error',
      'jsx-a11y/no-access-key': 'error',
      'jsx-a11y/no-distracting-elements': 'error',
      'jsx-a11y/no-interactive-element-to-noninteractive-role': [
        'error',
        { tr: ['none', 'presentation'], canvas: ['img'] },
      ],
      'jsx-a11y/no-noninteractive-element-interactions': [
        'error',
        {
          handlers: [
            'onClick',
            'onError',
            'onLoad',
            'onMouseDown',
            'onMouseUp',
            'onKeyPress',
            'onKeyDown',
            'onKeyUp',
          ],
          alert: ['onKeyUp', 'onKeyDown', 'onKeyPress'],
          body: ['onError', 'onLoad'],
          dialog: ['onKeyUp', 'onKeyDown', 'onKeyPress'],
          iframe: ['onError', 'onLoad'],
          img: ['onError', 'onLoad'],
        },
      ],
      'jsx-a11y/no-noninteractive-element-to-interactive-role': [
        'error',
        {
          ul: ['listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid'],
          ol: ['listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid'],
          li: ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'row', 'tab', 'treeitem'],
          table: ['grid'],
          td: ['gridcell'],
          fieldset: ['radiogroup', 'presentation'],
        },
      ],
      'jsx-a11y/no-noninteractive-tabindex': [
        'error',
        { tags: [], roles: ['tabpanel'], allowExpressionValues: true },
      ],
      'jsx-a11y/no-redundant-roles': 'error',
      'jsx-a11y/no-static-element-interactions': [
        'error',
        {
          allowExpressionValues: true,
          handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp'],
        },
      ],
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
      'jsx-a11y/scope': 'error',
      'jsx-a11y/tabindex-no-positive': 'error',

      // recommended から外す唯一のルール。
      // 現状の autoFocus は 9 箇所すべてが「オーバーレイを開いた時に主入力へ
      // 焦点を移す」用途で、これは WAI-ARIA Authoring Practices が dialog に
      // 対して推奨する挙動そのもの。本ルールはページ読み込み時の autoFocus
      // （こちらは実際に有害）と区別できないため、9 個の disable を並べる方が
      // ノイズになる。オーバーレイ以外で autoFocus を足す時はレビューで止める。
      'jsx-a11y/no-autofocus': 'off',
    },
  },

  // 本番コードは将来追加されるディレクトリも含めて named export に統一する。
  // framework / tooling が default export を契約に含めるentrypointだけを明示除外する。
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    ignores: [
      '**/*.test.{ts,tsx,js,jsx}',
      '**/*.spec.{ts,tsx,js,jsx}',
      '**/*.stories.{ts,tsx,js,jsx}',
      'src/app/**/{page,layout,loading,error,not-found,template,default}.{ts,tsx,js,jsx}',
      'src/app/{global-error,global-not-found,forbidden,unauthorized}.{ts,tsx,js,jsx}',
      'src/app/**/{icon,apple-icon,opengraph-image,twitter-image}.{ts,tsx,js,jsx}',
      'src/app/**/sitemap.{ts,js}',
      'src/app/{robots,manifest}.{ts,js}',
      // React Email CLI はtemplateのdefault exportをpreview entrypointとして扱う。
      'src/emails/**/*Email.{tsx,jsx}',
      'src/lib/i18n/request.ts',
    ],
    rules: {
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
    },
  },

  // =========================================================================
  // Feature Boundary: DAG（有向非循環グラフ）モデル
  //
  // Layer 0 (基盤):   activities — 他featureに依存しない
  // Layer 1 (中核):   timeblock, external-calendar — L0 barrel のみ
  // Layer 2 (体験):   calendar, review — L0+L1 barrel のみ
  // Independent:      auth, contact    — 他featureに依存しない
  //
  // settings:      feature から除外（app 層 composition に移動済み）
  // *.stories.tsx: DAG 除外（composition プレビュー層として cross-feature import を許容）
  //
  // ルール: 上位→下位の barrel import のみ許可。同層・下位→上位は禁止。
  // deep import（@/features/X/components/*）は常に禁止。
  // =========================================================================

  // ── 1. lib/ → features/, app/ のimport禁止 ──
  {
    files: ['src/lib/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/trpc/root.ts', // Server Composition Layer (router aggregator)
      'src/lib/hooks/useTheme.ts', // Re-export from app/_providers/theme-provider
      'src/lib/components/dnd/**', // DnD (stories only)
      'src/lib/**/*.stories.*', // Storybook files
      'src/lib/test/**', // Integration/E2E tests (deep imports are expected)
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*', '@/features/**'],
              message:
                '共有層→featureの逆依存は禁止。共有層に実体を移動するか、Composition Layerに配置。',
            },
            {
              group: ['@/app/*', '@/app/**'],
              message: '共有層→app層の逆依存は禁止。',
            },
          ],
        },
      ],
    },
  },

  // ── 2. Feature DAG ──

  // Layer 0 (activities): 他featureへの依存ゼロ
  {
    files: ['src/features/activities/**/*.{ts,tsx}'],
    ignores: ['**/*.stories.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*', '@/features/**'],
              message: 'Layer 0（基盤feature）は他featureに依存不可。',
            },
          ],
        },
      ],
    },
  },

  // Layer 1 (timeblock): L0 barrel のみ許可
  {
    files: ['src/features/timeblock/**/*.{ts,tsx}'],
    ignores: ['**/*.stories.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            // 同層間禁止（自分自身は含めない）
            {
              group: ['@/features/external-calendar', '@/features/external-calendar/**'],
              message: '同層featureのimport禁止。',
            },
            // L2 禁止
            {
              group: ['@/features/calendar', '@/features/calendar/**'],
              message: '上位層featureのimport禁止。',
            },
            {
              group: ['@/features/review', '@/features/review/**'],
              message: '上位層featureのimport禁止。',
            },
            // Independent 禁止
            {
              group: ['@/features/auth', '@/features/auth/**'],
              message: '独立featureのimport禁止。',
            },
            {
              group: ['@/features/contact', '@/features/contact/**'],
              message: '独立featureのimport禁止。',
            },
            // L0 deep import禁止（barrel のみ許可）
            {
              group: ['@/features/activities/**'],
              message: 'barrel import（@/features/activities）のみ使用。',
            },
          ],
        },
      ],
    },
  },

  // Layer 1 (external-calendar): L0 barrel のみ許可
  {
    files: ['src/features/external-calendar/**/*.{ts,tsx}'],
    ignores: ['**/*.stories.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            // 同層間禁止（自分自身は含めない）
            {
              group: ['@/features/timeblock', '@/features/timeblock/**'],
              message: '同層featureのimport禁止。',
            },
            // L2 禁止
            {
              group: ['@/features/calendar', '@/features/calendar/**'],
              message: '上位層featureのimport禁止。',
            },
            {
              group: ['@/features/review', '@/features/review/**'],
              message: '上位層featureのimport禁止。',
            },
            // Independent 禁止
            {
              group: ['@/features/auth', '@/features/auth/**'],
              message: '独立featureのimport禁止。',
            },
            {
              group: ['@/features/contact', '@/features/contact/**'],
              message: '独立featureのimport禁止。',
            },
            // L0 deep import禁止（barrel のみ許可）
            {
              group: ['@/features/activities/**'],
              message: 'barrel import（@/features/activities）のみ使用。',
            },
          ],
        },
      ],
    },
  },

  // Layer 2 (calendar): L0+L1 barrel のみ許可
  {
    files: ['src/features/calendar/**/*.{ts,tsx}'],
    ignores: ['**/*.stories.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            // 同層間禁止（自分自身は含めない）
            {
              group: ['@/features/review', '@/features/review/**'],
              message: '同層featureのimport禁止。',
            },
            // Independent 禁止
            {
              group: ['@/features/auth', '@/features/auth/**'],
              message: '独立featureのimport禁止。',
            },
            {
              group: ['@/features/contact', '@/features/contact/**'],
              message: '独立featureのimport禁止。',
            },
            // L0+L1 deep import禁止（barrel のみ許可）
            {
              group: ['@/features/activities/**'],
              message: 'barrel import（@/features/activities）のみ使用。',
            },
            {
              group: ['@/features/timeblock/**'],
              message: 'barrel import（@/features/timeblock）のみ使用。',
            },
            {
              group: ['@/features/external-calendar/**'],
              message: 'barrel import（@/features/external-calendar）のみ使用。',
            },
          ],
        },
      ],
    },
  },

  // Layer 2 (review): L0+L1 barrel のみ許可
  {
    files: ['src/features/review/**/*.{ts,tsx}'],
    ignores: ['**/*.stories.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            // 同層間禁止（自分自身は含めない）
            {
              group: ['@/features/calendar', '@/features/calendar/**'],
              message: '同層featureのimport禁止。',
            },
            // Independent 禁止
            {
              group: ['@/features/auth', '@/features/auth/**'],
              message: '独立featureのimport禁止。',
            },
            {
              group: ['@/features/contact', '@/features/contact/**'],
              message: '独立featureのimport禁止。',
            },
            // L0+L1 deep import禁止（barrel のみ許可）
            {
              group: ['@/features/activities/**'],
              message: 'barrel import（@/features/activities）のみ使用。',
            },
            {
              group: ['@/features/timeblock/**'],
              message: 'barrel import（@/features/timeblock）のみ使用。',
            },
            {
              group: ['@/features/external-calendar/**'],
              message: 'barrel import（@/features/external-calendar）のみ使用。',
            },
          ],
        },
      ],
    },
  },

  // Independent (auth, contact): 他featureへの依存ゼロ
  {
    files: ['src/features/auth/**/*.{ts,tsx}', 'src/features/contact/**/*.{ts,tsx}'],
    ignores: ['**/*.stories.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*', '@/features/**'],
              message: '独立featureは他featureに依存不可。',
            },
          ],
        },
      ],
    },
  },

  // Composition Feature (settings): 他featureへのimportは許可するが、deep importは禁止（barrelのみ）
  // AGENTS.md / `pr-cross-review` skill の「Composition Feature: settings」参照
  {
    files: ['src/features/settings/**/*.{ts,tsx}'],
    ignores: ['**/*.stories.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // サブディレクトリ列挙だと server/domain/schemas 等の新設パスを
              // 見逃す（Codex review 指摘）。catch-all で deep import 全体を禁止する。
              group: ['@/features/*/**'],
              message:
                'settings は composition feature のため他featureへのimportは許可されるが、deep importは禁止。barrel（@/features/featureName）経由で使用。',
            },
          ],
        },
      ],
    },
  },

  // ── 3. app/: feature deep import禁止（barrelのみ） ──
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/features/*/components/*',
                '@/features/*/hooks/*',
                '@/features/*/stores/*',
                '@/features/*/utils/*',
                '@/features/*/types/*',
                '@/features/*/lib/*',
                '@/features/*/constants/*',
                '@/features/*/contexts/*',
                '@/features/*/adapters/*',
              ],
              message: 'barrel import (@/features/featureName) のみ使用。',
            },
          ],
        },
      ],
    },
  },

  // テスト用グローバル変数
  {
    files: ['**/*.test.{js,jsx,ts,tsx}', '**/*.spec.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: {
        vi: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        test: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // logger.tsではconsole許可（開発用ロガー）
  {
    files: ['**/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // scripts/ではconsole許可 + CJS require許可（CLIツール）
  {
    files: ['scripts/**/*.{js,cjs,mjs,ts}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // public/ のJSファイル（Service Worker等）
  {
    files: ['public/**/*.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // .storybook/ のモックファイル
  {
    files: ['.storybook/**/*.{ts,tsx,js}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // supabase/ Edge Functions
  {
    files: ['supabase/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // src/lib/test/ではconsole許可（テストユーティリティ）
  {
    files: ['src/lib/test/**/*.{js,ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },

  // 開発専用コンポーネントではconsole許可
  {
    files: ['**/components/dev/**/*.{js,ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },

  // no-restricted-syntax は同一 files glob に複数 config を並べると、flat config が
  // ルールキー単位で丸ごと上書きする（配列マージされない）ため、`src/**/*.{ts,tsx}` を
  // 対象にする selector は 1 つの config object の配列にまとめる。ここに selector を
  // 追加する時は、既存 selector を上書きしないことを確認する。
  {
    files: ['src/**/*.{ts,tsx}'],
    // ignores はこの config object 内の全 selector（signInWithPassword / toZonedTime）に
    // 無差別適用される。新しい ignore を足す時は、対象外にしたい selector をコメントで明記する。
    ignores: [
      // signInWithPassword selector 用
      'src/lib/test/integration/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      // signInWithPassword selector 用: ログイン（ブラウザから captcha token 付きで呼ぶ）
      'src/features/auth/stores/useAuthStore.ts',
      // signInWithPassword selector 用: アカウント削除の本人確認。
      // service-role 経由で captcha を意図的に免除している
      'src/features/auth/server/password-reauthentication.ts',
      // toZonedTime selector 用: 集約先そのもの（selector の許可場所）
      'src/lib/date/timezone.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // signInWithPassword の呼び出し点を固定する（#1917 / #1925）
          //
          // 認証済み画面から公開 Auth endpoint で再認証すると、production の Bot Protection 下で
          // 必ず captcha_failed になる（#1917 で設定画面の 2 ダイアログから撤去済み）。新しい
          // 呼び出しが増えると同じ故障を再導入するため、許可した場所以外では書けなくする。
          //
          // AST ベースなので doc comment 内のコード例（src/lib/supabase/client.ts）は一致しない。
          // 既存の呼び出しが消えることは検出しない（superset 検査）— 守るのは「増やさないこと」。
          selector: "MemberExpression[property.name='signInWithPassword']",
          message:
            'signInWithPassword の新規呼び出しは禁止。認証済み画面からの再認証は Bot Protection 下で必ず失敗する（#1917）。削除フローの本人確認は features/auth/server/password-reauthentication.ts を使う。',
        },
        {
          // 壁時計 Date の TZ 再解釈ミスを class ごと封じる（#2017）
          //
          // toZonedTime は「instant → 指定TZの壁時計フィールド」変換。date-fns のローカル
          // フィールド演算（setHours 等）で作った壁時計 Date に直接掛けると instant として
          // 誤って再解釈され、ブラウザ TZ ≠ ユーザー設定 TZ の時に日付がずれる
          // （external-event-day-selection.ts と useCalendarData.ts で実際に発生した同型バグ）。
          // 変換は @/lib/date/timezone に集約済み（toTZStartISO 等）なので、feature/app 層からの
          // 直接 import を禁止し、集約 helper 経由を強制する。
          selector:
            "ImportDeclaration[source.value='date-fns-tz'] ImportSpecifier[imported.name='toZonedTime']",
          message:
            'toZonedTime の直接 import は禁止（壁時計 Date への誤適用で日付がずれるバグ class、#2017）。@/lib/date/timezone の集約 helper（toTZStartISO / toTZEndISO / tzIsSameDay / isTodayInTimezone 等）を使う。',
        },
      ],
    },
  },

  // Storybook
  ...storybook.configs['flat/recommended'],
]);

export default eslintConfig;
