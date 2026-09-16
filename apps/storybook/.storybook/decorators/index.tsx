/// <reference types="vite/client" />
/**
 * 全Storyに適用するdecorators集約
 *
 * preview.tsx から decorators ロジックを分離。
 * Zustand ストアモック → テーマ → tRPC → i18n の順でラップする。
 */
import type { Decorator } from '@storybook/nextjs-vite';
import { useDarkMode } from '@vueless/storybook-dark-mode';
import { NextIntlClientProvider } from 'next-intl';
import { useEffect } from 'react';

import { StorybookThemeProvider } from '../mocks/theme';
import type { MockResponseMap } from '../mocks/trpc';
import { StoryTRPCProvider } from '../mocks/trpc';

export { storeMockDecorator } from '../mocks/stores';

/**
 * Story を任意の className でラップする decorator factory
 *
 * よくある「固定幅で Story をプレビューする」パターンをまとめる:
 * `withWrapper('w-[500px]')` で `<div className="w-[500px]"><Story /></div>` 相当。
 * 既存の inline decorator と完全に同じ JSX を返すため見た目に影響しない。
 */
export const withWrapper = (className: string): Decorator => {
  const WrappedStory: Decorator = (Story) => (
    <div className={className}>
      <Story />
    </div>
  );
  return WrappedStory;
};

// メッセージファイルを自動収集（namespace追加時に変更不要）
// Next.js 16.3+ が独自の import.meta.glob 型（Turbopack対応）をグローバルに追加し、
// vite/client.d.ts の ImportGlobFunction とマージされ generic 呼び出しが壊れるため、
// ジェネリック引数を渡さず結果を直接キャストする。
const messageModules = import.meta.glob('../../../product/messages/ja/*.json', {
  eager: true,
}) as Record<string, Record<string, string>>;
const messages = Object.entries(messageModules).reduce<Record<string, unknown>>(
  (acc, [, mod]) => ({ ...acc, ...(mod as Record<string, unknown>) }),
  {},
);

/** テーマ + tRPC + i18n プロバイダ */
export const providerDecorator: Decorator = (Story, context) => {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Storybook decorator は React コンポーネントとして実行される
  const toolbarDark = useDarkMode();
  const forcedTheme = context.parameters.testTheme;
  const resolvedTheme =
    forcedTheme === 'light' || forcedTheme === 'dark'
      ? forcedTheme
      : toolbarDark
        ? 'dark'
        : 'light';

  // eslint-disable-next-line react-hooks/rules-of-hooks -- Storybook decorator は React コンポーネントとして実行される
  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(resolvedTheme);
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  // parameters.trpcMocks / trpcPending / trpcError を読み取り
  const trpcMocks = context.parameters.trpcMocks as MockResponseMap | undefined;
  const trpcPending = context.parameters.trpcPending as boolean | undefined;
  const trpcError = context.parameters.trpcError as
    { path: string; code: string; message?: string } | undefined;

  return (
    <StorybookThemeProvider resolvedTheme={resolvedTheme}>
      <StoryTRPCProvider
        {...(trpcMocks !== undefined ? { mocks: trpcMocks } : {})}
        {...(trpcPending !== undefined ? { pending: trpcPending } : {})}
        {...(trpcError !== undefined ? { error: trpcError } : {})}
      >
        <NextIntlClientProvider locale="ja" messages={messages}>
          <div>
            <Story />
          </div>
        </NextIntlClientProvider>
      </StoryTRPCProvider>
    </StorybookThemeProvider>
  );
};
