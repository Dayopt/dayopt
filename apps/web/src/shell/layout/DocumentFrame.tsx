import { cn } from '@dayopt/components';
import { ThemeProvider } from '@web/shell/providers/theme-provider';
import { Source_Sans_3 } from 'next/font/google';
import localFont from 'next/font/local';
import type { CSSProperties } from 'react';
import '../../styles/fonts/japanese-body.css';
import '../../styles/fonts/japanese-hero.css';

// product（apps/product/src/app/layout.tsx）と同一のフォントスタック。
// 変数名は foundations の tokens/typography.css が参照するものに合わせる。
//
// fallback に generic family（sans-serif / system-ui 等）を入れない。next/font は
// fallback の中身を font-family の末尾に連結するため、generic が --font-latin の中に入ると
// stack 上で和文フォントより前に来てしまう。generic を含むシステムフォールバックの尾は
// typography.css 側だけが持つ。
const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-latin-full',
  preload: false,
});

// 同じ書体・字形のまま共通文言を1ファイルにまとめる。
// 任意の本文文字には各 content route の ContentTypography が full を足す。
// generic fallback は foundations の stack 末尾だけに置く。
const webLatin = localFont({
  src: '../../styles/fonts/SourceSans3-web.woff2',
  weight: '200 900',
  display: 'swap',
  variable: '--font-latin-subset',
  adjustFontFallback: false,
  preload: true,
});

export function DocumentFrame({
  children,
  locale = 'en',
  head,
}: {
  children: React.ReactNode;
  locale?: string;
  head?: React.ReactNode;
}) {
  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${sourceSans.variable} ${webLatin.variable}`}
      style={
        {
          '--font-latin': 'var(--font-latin-subset), var(--font-latin-full)',
          '--font-noto-jp': 'var(--font-noto-jp-subset)',
          '--font-noto-jp-subset': '"Dayopt Web JP"',
          '--font-noto-jp-hero': '"Dayopt Web JP Hero"',
        } as CSSProperties
      }
    >
      <head>{head}</head>
      <body className={cn('bg-background antialiased')} suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
