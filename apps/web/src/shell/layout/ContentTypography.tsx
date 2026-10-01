import { Noto_Sans_JP } from 'next/font/google';
import type { ReactNode } from 'react';

import '../../styles/fonts/japanese-content.css';
import './ContentTypography.css';

// LP の共通文言は root の subset で網羅する。本文・検索結果・入力文字には
// 既存の全文字フォントも必要なので、この定義を各 content route で読み込む。
const fullJapanese = Noto_Sans_JP({
  subsets: ['latin'],
  weight: 'variable',
  display: 'swap',
  preload: false,
});

export function ContentTypography({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        fontFamily: `var(--font-latin), var(--font-noto-jp-subset), "Dayopt Content JP", ${fullJapanese.style.fontFamily}, var(--font-stack-sans)`,
      }}
    >
      {children}
    </div>
  );
}
