import type { Preview } from '@storybook/nextjs-vite';
import { sb } from 'storybook/test';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';

// product globals + apps/web の @source を含む Storybook 用 Tailwind エントリ
import { providerDecorator, storeMockDecorator } from './decorators';
import './tailwind-storybook.css';
import { dayoptDarkTheme, dayoptLightTheme } from './theme/dayopt';
import { DocsTemplate, ThemedDocsContainer } from './theme/docs';
import './theme/overrides.css';

// UI の隔離検証では外部 HIBP API を呼ばない。通信契約は product の unit test が担う。
sb.mock('../../product/src/lib/auth/pwned-password.ts');

const preview: Preview = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: '/ja',
        params: { locale: 'ja' },
      },
    },
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    viewport: {
      options: {
        ...MINIMAL_VIEWPORTS,
      },
    },
    backgrounds: {
      options: {},
      grid: {
        cellSize: 16,
        cellAmount: 5,
        opacity: 0.6,
        offsetX: 16,
        offsetY: 16,
      },
    },
    options: {
      storySort: {
        method: 'alphabetical',
        // top-level は所有境界（package / app）で分ける
        order: [
          // Shared = packages（再利用資産）
          'Shared',
          [
            'Foundations',
            'Components',
            // Shared/Components 直下は責務ベース taxonomy（ADR-022）の流れで並べる
            [
              'Identity',
              'Actions',
              'Inputs',
              'Navigation',
              'Feedback',
              'Overlays',
              'Display',
              'Layout',
              'Utilities',
            ],
            'Patterns',
          ],
          // Product = apps/product
          'Product',
          ['Components', 'Features', 'Patterns', 'Emails'],
          // Web = apps/web
          'Web',
          [
            'Components',
            // Shell（chrome）→ 以降は責務ベース（Shared/Components ADR-022 と揃える）
            [
              'Shell',
              'Actions',
              'Inputs',
              'Navigation',
              'Feedback',
              'Overlays',
              'Display',
              'Layout',
            ],
            'Sections',
            'Pages',
          ],
        ],
      },
    },
    darkMode: {
      dark: dayoptDarkTheme,
      light: dayoptLightTheme,
      stylePreview: true,
      classTarget: 'html',
    },
    docs: {
      codePanel: true,
      container: ThemedDocsContainer,
      page: DocsTemplate,
    },
    a11y: {
      config: {
        rules: [
          { id: 'color-contrast', enabled: true },
          // Storybook iframe構造に起因する誤検出を無効化
          { id: 'html-has-lang', enabled: false },
          { id: 'landmark-one-main', enabled: false },
          { id: 'page-has-heading-one', enabled: false },
          { id: 'region', enabled: false },
          // Story単体表示では見出し階層が不完全になるのは構造上正常
          { id: 'heading-order', enabled: false },
          // Radix UI の内部実装による aria-checked 等の誤検出
          { id: 'aria-prohibited-attr', enabled: false },
          // Radix ScrollArea / Calendar grid の内部スクロールコンテナ
          { id: 'scrollable-region-focusable', enabled: false },
        ],
      },

      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'error',
    },
  },
  decorators: [
    // Zustand ストアモック（parameters.storeMocks）
    storeMockDecorator,
    // テーマ + tRPC + i18n プロバイダ
    providerDecorator,
  ],
};

export default preview;
