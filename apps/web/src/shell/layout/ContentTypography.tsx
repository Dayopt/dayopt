import type { ReactNode } from 'react';

import '../../styles/fonts/japanese-content.css';
import '../../styles/fonts/japanese-full.css';
import './ContentTypography.css';

// 現在の本文は subset、その他の文字は同じ書体の full face で補う。
// 大量の Unicode-range 宣言を含む stylesheet を初期描画から外す。

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
        fontFamily:
          'var(--font-latin), var(--font-noto-jp-subset), "Dayopt Content JP", "Dayopt Content JP Full", var(--font-stack-sans)',
      }}
    >
      {children}
    </div>
  );
}
