import { japaneseReadingFonts } from '@web/styles/fonts/preloads';
import type { CSSProperties, ReactNode } from 'react';

import '../../styles/fonts/japanese-collections.css';
import './ContentTypography.css';

// 現在の本文は subset、その他の文字は同じ書体の full face で補う。
// 大量の Unicode-range 宣言を含む stylesheet を初期描画から外す。

export function ContentTypography({
  children,
  className,
  collection,
  locale,
}: {
  children: ReactNode;
  className?: string;
  collection?: 'blog' | 'docs' | 'legal';
  locale?: string;
}) {
  const family = collection
    ? `Dayopt ${collection.charAt(0).toUpperCase()}${collection.slice(1)} JP`
    : 'Dayopt Content JP';
  const preloads = [
    japaneseReadingFonts.regular,
    ...(collection ? [japaneseReadingFonts.medium, japaneseReadingFonts[collection]] : []),
  ];
  return (
    <div
      className={className}
      style={
        {
          '--font-reading-jp': `"${family}"`,
          fontFamily: `var(--font-latin), var(--font-noto-jp-subset), "${family}", "Dayopt Content JP", "Dayopt Content JP Full", var(--font-stack-sans)`,
        } as CSSProperties
      }
    >
      {locale === 'ja' &&
        preloads.map((href) => (
          <link
            key={href}
            rel="preload"
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
            href={href}
          />
        ))}
      {children}
    </div>
  );
}
