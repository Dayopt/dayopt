/**
 * ルートレイアウト
 *
 * @description
 * 最小限の責務のみを持つルートレイアウト。
 * Providersは各Route Groupのレイアウトで適用する。
 *
 * 責務:
 * - グローバルCSS読み込み
 * - フォント設定（Source Sans 3, Noto Sans JP）
 * - HTML/body構造
 * - Vercel Analytics/SpeedInsights
 *
 * @see src/app/[locale]/(app)/layout.tsx - 認証必須ページ用Providers
 * @see src/app/[locale]/(auth)/layout.tsx - 認証ページ用Providers
 * @see src/app/[locale]/legal/layout.tsx - 法的文書用Providers
 */
import '@/lib/styles/globals.css';

import type { Metadata, Viewport } from 'next';
import { Noto_Sans_JP, Source_Sans_3 } from 'next/font/google';
import { headers } from 'next/headers';
import { Suspense } from 'react';

import { DeferredAnalytics } from '@/lib/analytics/DeferredAnalytics';
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme/theme-bootstrap-script';
import { cn } from '@dayopt/components';

// next/font による最適化されたフォント読み込み（Variable Font: wght軸のみ）
// preload: true でLCP改善（デフォルトでtrueだが明示的に指定）
//
// 変数名は Tailwind 組み込みの theme キー（--font-sans）と衝突させない。
// html 要素の class で注入されると :root の theme 値を上書きし、
// font-sans utility が和文フォールバックを失うため。合成は foundations の typography.css で行う。
//
// fallback に generic family（sans-serif / system-ui 等）を入れない。next/font は
// fallback の中身を font-family の末尾に連結するため、generic が --font-latin の中に入ると
// stack 上で和文フォントより前に来てしまう。generic を含むシステムフォールバックの尾は
// typography.css 側だけが持つ。
const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-latin',
  preload: true,
});

// 日本語フォント（GAFA方針準拠: Google = Noto Sans JP）
// weight: 400, 500のみ — 700(bold)は不使用、500(medium)で見出し・強調を表現
const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-noto-jp',
  preload: true,
});

/**
 * Viewport設定（モバイルUX最適化）
 *
 * @see https://developer.apple.com/design/human-interface-guidelines/
 * @see https://css-tricks.com/the-notch-and-css/
 *
 * - viewportFit: 'cover' → iPhone X以降のノッチ/Dynamic Island対応
 * - themeColor → ThemeProviderで動的に設定（oklchトークンから自動取得）
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
};

/**
 * メタデータ設定（PWA・SEO最適化）
 *
 * @see https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
 */
export const metadata: Metadata = {
  title: {
    template: '%s - Dayopt',
    default: 'Dayopt',
  },
  description: 'Dayopt - Task management and productivity application',
  // iOS PWA設定（Apple Human Interface Guidelines準拠）
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Dayopt',
  },
  // Android PWA向け追加設定
  applicationName: 'Dayopt',
  formatDetection: {
    telephone: false,
  },
  // PWAマニフェスト参照
  manifest: '/manifest.json',
  // アイコン設定（iOS/Android/デスクトップ対応）
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    // iOS用アイコン（Safari Home Screen対応）
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

interface RootLayoutProps {
  children: React.ReactNode;
  params: Promise<{ locale?: string }>;
}

const RootLayout = async ({ children, params }: RootLayoutProps) => {
  const resolvedParams = await params;
  const locale = resolvedParams?.locale || 'en';
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${sourceSans.variable} ${notoSansJP.variable}`}
    >
      <head>
        {/* 初回描画前にテーマ class を付ける（ダークテーマの白フラッシュ防止） */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        {/* LCP改善: Supabase API への早期接続確立（preconnect + dns-prefetch） */}
        {process.env.NEXT_PUBLIC_SUPABASE_URL && (
          <>
            <link rel="preconnect" href={process.env.NEXT_PUBLIC_SUPABASE_URL} />
            <link rel="dns-prefetch" href={process.env.NEXT_PUBLIC_SUPABASE_URL} />
          </>
        )}
        {/*
         * iOS スプラッシュスクリーン（apple-touch-startup-image）
         *
         * Next.js の Metadata API は apple-touch-startup-image に未対応のため手動指定。
         * 各デバイスの論理解像度 × デバイスピクセル比 = 物理解像度で media クエリを設定。
         *
         * @see https://developer.apple.com/design/human-interface-guidelines/
         * @see https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
         */}
        {/* iPhone 16 Pro Max (430×932 @3x) */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
          href="/splash/splash-1290x2796.png"
        />
        {/* iPhone 16 Pro / 15 Pro (393×852 @3x) */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
          href="/splash/splash-1179x2556.png"
        />
        {/* iPhone 16 Plus / 15 Plus / 14 Plus (430×932 @3x) — same as 16 Pro Max bucket */}
        {/* iPhone 15 / 14 Pro (393×852 @3x) — same as 16 Pro bucket */}
        {/* iPhone 14 (390×844 @3x) */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
          href="/splash/splash-1170x2532.png"
        />
        {/* iPhone SE 3rd gen / 8 / 7 (375×667 @2x) */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
          href="/splash/splash-750x1334.png"
        />
        {/* iPad Pro 12.9" (1024×1366 @2x) */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
          href="/splash/splash-2048x2732.png"
        />
        {/* iPad Pro 11" / Air 5th gen (834×1194 @2x) */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
          href="/splash/splash-1668x2388.png"
        />
        {/* iPad Air 4th gen / iPad mini 6th gen (820×1180 @2x) */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
          href="/splash/splash-1640x2360.png"
        />
        {/* iPad 10th gen (820×1180 @2x) — same bucket as above */}
        {/* iPad 9th gen (768×1024 @2x) */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
          href="/splash/splash-1536x2048.png"
        />
      </head>
      <body className={cn('bg-background')} suppressHydrationWarning>
        {/* SSR timezone detection: 2回目以降のSSRで正しいタイムゾーンを使用 */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `if(!document.cookie.includes('user-tz='))document.cookie='user-tz='+Intl.DateTimeFormat().resolvedOptions().timeZone+';path=/;max-age=31536000;SameSite=Lax';`,
          }}
        />
        <Suspense fallback={null}>
          {children}
          {/* LCP/TBT改善: Analyticsを遅延読み込み（-300ms/-150ms） */}
          <DeferredAnalytics />
        </Suspense>
      </body>
    </html>
  );
};

export default RootLayout;
