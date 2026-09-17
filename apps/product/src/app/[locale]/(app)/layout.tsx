/**
 * 認証必須ページ用レイアウト
 *
 * @description
 * 認証が必要なページ（/calendar, /settings等）で使用。
 * IntlProvider でアプリ用namespace のみクライアントに配信。
 *
 * 責務分離:
 * - このlayout: IntlProvider（i18n）+ Providers（データ層）+ BaseLayout（UIシェル）
 * - GlobalOverlays: グローバルダイアログ群（別ファイルに分離）
 *
 * @see src/shell/providers.tsx - フルProviders定義
 * @see ./_overlays/GlobalOverlays.tsx - グローバルダイアログ群
 */
import { InitialCalendarDateProvider } from '@/lib/calendar-initial-date';
import { headers } from 'next/headers';
import { prefetchAppShell, resolveInitialCalendarDate } from './_server/prefetch-app-shell';

import type { Metadata } from 'next';

import { IntlProvider } from '@/lib/i18n';
import { Providers } from './_providers/Providers';
import { BaseLayout } from './_shell/base-layout';

/** 認証必須ページはクロール不要（noindex） */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

import { GlobalOverlays } from './_overlays/GlobalOverlays';

/** アプリページで必要なnamespace */
const APP_NAMESPACES = [
  'activities',
  'auth',
  'common',
  'calendar',
  'timeblock',
  'plan',
  'record',
  'navigation',
  'report',
  'settings',
  'sidebar',
  'shortcuts',
  'error',
  'contact',
];

interface AppLayoutProps {
  children: React.ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps) {
  const dehydratedState = await prefetchAppShell();
  const requestHeaders = await headers();
  const timezone = requestHeaders.get('x-user-timezone') ?? 'UTC';
  const dateKey = resolveInitialCalendarDate(new Date(), timezone);
  return (
    <IntlProvider namespaces={APP_NAMESPACES}>
      <InitialCalendarDateProvider dateKey={dateKey}>
        <Providers dehydratedState={dehydratedState}>
          <BaseLayout>
            {/*
             * GlobalOverlays は children より先に置く。React は effect を tree 順に実行するため、
             * 後ろに置くと page の mount effect が Toaster の購読より先に走る。sonner は購読前に
             * publish された toast を再生しないので、初回ロード時に page 側で出した toast が
             * そのまま失われる（Stripe Checkout や Google Calendar OAuth の復帰はフルロードなので
             * 必ずこの経路に当たる）。Toaster は fixed、dialog は portal なので描画順に依存しない。
             */}
            <GlobalOverlays />
            {children}
          </BaseLayout>
        </Providers>
      </InitialCalendarDateProvider>
    </IntlProvider>
  );
}
