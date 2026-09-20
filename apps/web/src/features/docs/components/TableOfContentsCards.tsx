'use client';

import { TocLinks } from './AutoTableOfContents';
import { ClientTableOfContents } from './ClientTableOfContents';

interface TableOfContentsCardsProps {
  content?: string;
}

/**
 * 目次を「目次 card」と「リンク card」の2枚に分けて縦に並べる共通レイアウト。
 * blog 記事・docs 記事の両方で使用する（sticky 位置・余白は呼び出し側で指定）。
 */
export function TableOfContentsCards({ content }: TableOfContentsCardsProps) {
  if (!content) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* card 1: 目次（スクロールなし。全項目を常に表示する） */}
      <div className="bg-card text-card-foreground border-border-subtle rounded-lg border p-4 shadow-sm">
        <ClientTableOfContents content={content} showLinks={false} />
      </div>
      {/* card 2: リンク（問題の報告） */}
      <div className="bg-card text-card-foreground border-border-subtle rounded-lg border p-4 shadow-sm">
        <TocLinks />
      </div>
    </div>
  );
}
