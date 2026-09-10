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
 * - 1行構成、description なし
 * - 背景: card、枠線: border（タイプ別カラー分けなし）
 * - 角丸: 8px、影: shadow-card
 * - 高さ: 48px 固定、幅: 100vw-32px(mobile) / 360px(desktop)
 * - アクション: 本文と同じ文字色 + hover の地色（brand color は使わない。
 *   「元に戻す」はこの面の主役ではなく、押さない選択も同じだけ正しい）
 * - ×ボタンなし
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
 * 「元に戻す」付きが出ている間は Esc での消去を効かせない。Inspector も Esc で閉じるので
 * （useInspectorKeyboard / useCalendarTimeblockKeyboard）、削除直後の 1 打が二役になり、
 * 取り消し口まで消えてしまう。
 *
 * トースト本体のクリックは別扱いで、取り消し付きでも消す。狙って押した操作なので
 * 巻き添えにならず、×ボタンを置かない以上ここが唯一の「今すぐ消す」導線になる
 * （アクションリンク上のクリックは呼び出し側が除外済み）。
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
      sonnerToast.dismiss();
    };
    // capture で受ける。Radix の dismissable layer（メニュー / ポップオーバーの
    // 外側クリック判定）が bubble を止めることがあり、その後ろで待つと消せない
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
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
          // brand color を当てない。地の文字色 + hover の地色で「押せる」ことだけ示す
          actionButton:
            'shrink-0 -mr-1 cursor-pointer rounded-lg border-0 bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-state-hover md:text-xs',
          loader: '!static !inset-auto !transform-none',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
