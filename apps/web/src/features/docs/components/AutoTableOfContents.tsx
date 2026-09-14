'use client';

import { Link } from '@dayopt/i18n/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { TocItem, generateTableOfContents } from '../lib/toc';

interface AutoTableOfContentsProps {
  content: string;
  className?: string;
  /** 下部の Links（問題の報告）を内包表示するか。別 card に分けたい場合は false。 */
  showLinks?: boolean;
}

/**
 * TOC 下部のリンク（問題の報告）。単体でも別 card として使える。
 *
 * repository は非公開のため GitHub の issue / source へは誘導せず、誰でも開ける
 * お問い合わせページへ送る。
 */
export function TocLinks() {
  const t = useTranslations('docs.toc');

  return (
    <div>
      <div className="text-muted-foreground mb-4 text-xs font-medium tracking-wider uppercase">
        {t('links')}
      </div>
      <ul className="space-y-2">
        <li>
          <Link
            href="/contact"
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            {t('reportIssue')}
          </Link>
        </li>
      </ul>
    </div>
  );
}

interface TocListProps {
  items: TocItem[];
  level?: number;
  activeId: string;
  onItemClick: (id: string) => void;
}

function TocList({ items, level = 0, activeId, onItemClick }: TocListProps) {
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.id}>
          <button
            onClick={() => onItemClick(item.id)}
            className={`relative block w-full py-1 pl-4 text-left text-sm transition-colors ${
              activeId === item.id
                ? 'text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title={item.title}
          >
            {activeId === item.id && (
              <span
                className="bg-foreground absolute inset-y-0 left-0 w-0.5 rounded-full"
                aria-hidden="true"
              />
            )}
            <span className="line-clamp-2">{item.title}</span>
          </button>
          {item.children && item.children.length > 0 && (
            <TocList
              items={item.children}
              level={level + 1}
              activeId={activeId}
              onItemClick={onItemClick}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function AutoTableOfContents({
  content,
  className = '',
  showLinks = true,
}: AutoTableOfContentsProps) {
  const t = useTranslations('docs.toc');
  const [toc, setToc] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [isLoaded, setIsLoaded] = useState(false);

  // コンテンツから目次を生成
  useEffect(() => {
    try {
      const tocItems = generateTableOfContents(content);
      setToc(tocItems);
      setIsLoaded(true);
    } catch {
      setIsLoaded(true);
    }
  }, [content]);

  // アクティブな見出しを追跡
  useEffect(() => {
    if (toc.length === 0) return;

    const flatTocItems = flattenTocItems(toc);
    const headingIds = flatTocItems.map((item) => item.id).filter(Boolean);

    const updateActiveHeading = () => {
      const mainElement = getScrollableMain();
      const scrollTop = mainElement?.scrollTop ?? window.scrollY;
      const offset = 100; // ヘッダー高さを考慮

      let currentActiveId = '';

      // スクロール位置より上にある最後の見出しを探す
      for (const id of headingIds) {
        const element = document.getElementById(id);
        if (!element) continue;

        const elementTop = mainElement
          ? element.offsetTop - mainElement.offsetTop
          : element.getBoundingClientRect().top + window.scrollY;

        if (elementTop <= scrollTop + offset) {
          currentActiveId = id;
        } else {
          break;
        }
      }

      // 最後の見出し直後のコンテンツが短いと、しきい値に届かず最後まで
      // スクロールしても currentActiveId が更新されないため、最下部到達時は
      // 最後の見出しを強制的にアクティブにする
      const maxScrollTop = mainElement
        ? mainElement.scrollHeight - mainElement.clientHeight
        : document.documentElement.scrollHeight - window.innerHeight;
      const lastHeadingId = headingIds[headingIds.length - 1];
      if (lastHeadingId && scrollTop >= maxScrollTop - 2) {
        currentActiveId = lastHeadingId;
      }

      setActiveId(currentActiveId);
    };

    // 初期設定
    setTimeout(updateActiveHeading, 100);

    // スクロールコンテナ（docs は main、marketing は window）を監視
    const mainElement = getScrollableMain();
    if (mainElement) {
      mainElement.addEventListener('scroll', updateActiveHeading, { passive: true });
    }
    window.addEventListener('scroll', updateActiveHeading, { passive: true });

    return () => {
      if (mainElement) {
        mainElement.removeEventListener('scroll', updateActiveHeading);
      }
      window.removeEventListener('scroll', updateActiveHeading);
    };
  }, [toc]);

  // スムーズスクロール
  const handleItemClick = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      // スクロール検出を待たず、クリックした項目を即座にハイライトする
      setActiveId(id);

      const mainElement = getScrollableMain();
      // main がスクロールする docs は 32、sticky header の marketing は header 分(約80)を確保
      const headerOffset = mainElement ? 32 : 80;

      if (mainElement) {
        // main要素内でスクロール
        const elementPosition = element.offsetTop - headerOffset;
        mainElement.scrollTo({
          top: elementPosition,
          behavior: 'smooth',
        });
      } else {
        // window スクロール（sticky header を考慮）
        const elementPosition = element.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.scrollY - headerOffset;

        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth',
        });
      }

      // URLハッシュを更新（履歴には追加しない）
      if (history.replaceState) {
        history.replaceState(null, '', `#${id}`);
      }
    }
  };

  // 目次が空の場合は非表示
  if (!isLoaded || toc.length === 0) {
    return (
      <div className={`space-y-4 ${className}`}>
        <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {t('onThisPage')}
        </div>
        {!isLoaded ? (
          <div className="text-muted-foreground text-sm">{t('loading')}</div>
        ) : (
          <div className="text-muted-foreground text-sm">{t('noHeadings')}</div>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
        {t('onThisPage')}
      </div>

      <nav className="relative">
        <span
          className="bg-border absolute inset-y-0 left-0 w-0.5 rounded-full"
          aria-hidden="true"
        />
        <TocList items={toc} activeId={activeId} onItemClick={handleItemClick} />
      </nav>

      {/* Links（showLinks=false の場合は呼び出し側で別 card として TocLinks を描画する） */}
      {showLinks && (
        <div className="border-border border-t pt-4">
          <TocLinks />
        </div>
      )}
    </div>
  );
}

/**
 * 実際にスクロールするコンテナを返す。
 * docs レイアウトは `#main-content` 自体がスクロールするが、marketing（blog）レイアウトでは
 * `#main-content` は存在しても window がスクロールする。スクロール可能でなければ null を返し、
 * 呼び出し側は window スクロールにフォールバックする。
 */
function getScrollableMain(): HTMLElement | null {
  const main = document.getElementById('main-content');
  if (main && main.scrollHeight > main.clientHeight + 1) {
    return main;
  }
  return null;
}

// 階層化された目次をフラットなリストに変換
function flattenTocItems(items: TocItem[]): TocItem[] {
  const flattened: TocItem[] = [];

  for (const item of items) {
    flattened.push(item);
    if (item.children) {
      flattened.push(...flattenTocItems(item.children));
    }
  }

  return flattened;
}
