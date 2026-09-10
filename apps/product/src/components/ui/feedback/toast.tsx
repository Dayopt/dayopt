'use client';

import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { Toaster as Sonner, toast as sonnerToast } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Toast通知コンポーネント（v2: ミニマル1行デザイン）
 *
 * デザイン仕様:
 * - 1行構成、description なし、×ボタンなし
 * - 背景: card、枠線: border（タイプ別カラー分けなし）
 * - 角丸: 8px、影: shadow-card
 * - 高さ: 48px 固定、幅: 100vw-32px(mobile) / 360px(desktop)
 * - アクション: テキストリンク（brand color）
 * - 消去: 自動(3s/5s) + swipe(mobile) + Esc/クリック(desktop)
 * - 同時表示: 最大1つ、cross-fade 差し替え
 *
 * @example
 * ```tsx
 * import { toast } from '@/lib/toast';
 *
 * toast.success('保存しました');
 * toast.success('削除しました', {
 *   action: { label: '元に戻す', onClick: () => restoreItem() },
 * });
 * ```
 */
/**
 * 「元に戻す」付きが出ている間は、ついでの消去を効かせない。Inspector も Esc で
 * 閉じるので（useInspectorKeyboard / useCalendarTimeblockKeyboard）、削除直後の 1 打で
 * 取り消し口まで消えてしまう。クリックも同じく、狙っていない場所への 1 クリックで
 * 戻し口を失わせない。取り消しは 5 秒で自然に消える。
 */
const hasUndoableToast = (): boolean => {
  try {
    return sonnerToast.getToasts().some((item) => 'action' in item && item.action != null);
  } catch {
    return false;
  }
};

const Toaster = ({ ...props }: ToasterProps) => {
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const t = useTranslations('common.aria');

  // デスクトップ: トーストクリックで消去（アクションリンクは除外）
  useEffect(() => {
    if (isMobile) return;
    const handler = (e: MouseEvent) => {
      const toastEl = (e.target as Element).closest('[data-sonner-toast]');
      if (!toastEl) return;
      if ((e.target as Element).closest('[data-action]')) return;
      if (hasUndoableToast()) return;
      sonnerToast.dismiss();
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [isMobile]);

  // デスクトップ: Esc キーで消去
  useEffect(() => {
    if (isMobile) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (hasUndoableToast()) return;
      sonnerToast.dismiss();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isMobile]);

  return (
    <Sonner
      // デスクトップは下中央。右側は詳細パネル（Inspector）が常駐し、右下に出すと
      // メモ欄や削除系の操作に「元に戻す」が被って押し間違いを誘う。下中央はグリッドの
      // 深夜帯に当たり、どのパネルを開いていても操作対象と重ならない。
      // モバイルは Drawer が下から出るので上中央のまま
      position={isMobile ? 'top-center' : 'bottom-center'}
      visibleToasts={1}
      duration={3000}
      containerAriaLabel={t('toastContainer')}
      className={isMobile ? '' : '[--width:360px]'}
      offset={isMobile ? { top: 16 } : { bottom: 16 }}
      mobileOffset={{ top: 16, left: 16, right: 16 }}
      swipeDirections={isMobile ? ['left', 'right'] : []}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex items-center gap-2 !h-12 w-full px-4 rounded-lg border border-border shadow-card bg-card text-foreground',
          icon: 'shrink-0 [&_svg]:size-4',
          content: 'min-w-0 flex-1 [[data-sonner-toast]:not(:has([data-icon]))_&]:col-start-1',
          title: 'text-base md:text-sm truncate',
          description: 'sr-only',
          actionButton:
            'shrink-0 text-sm md:text-xs text-primary bg-transparent border-0 p-0 cursor-pointer',
          loader: '!static !inset-auto !transform-none',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
