'use client';

import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useTranslations } from 'next-intl';
import { Toaster as Sonner } from 'sonner';

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
 * - 右上の角に×。絶対配置なので本文の幅を取らない。普段は透明で、ポインタが
 *   トーストに乗った時とキーボードでフォーカスした時だけ現れる
 * - 消去: 自動(3s/5s、ホバー中は止まる) + ×(desktop) + swipe(mobile)
 * - 同時表示: 最大1つ、cross-fade 差し替え
 *
 * 本文クリックと Esc では消さない。どちらも標準的な作りではなく（Material の
 * snackbar / sonner / Linear のどれも持たない）、隣にアクションがある面では意図が
 * 曖昧になる。Esc は Inspector を閉じる操作と一打が二役になり、削除直後の 1 打で
 * 取り消し口まで消していた。「今すぐ消す」は×へ集約する。
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
const Toaster = ({ ...props }: ToasterProps) => {
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const t = useTranslations('common.aria');

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
      closeButton={!isMobile}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: t('close'),
        classNames: {
          // group / relative: × を角へ浮かせ、トーストのホバーでだけ出すため
          toast:
            'group relative flex items-center gap-2 !h-12 w-full px-4 rounded-lg border border-border shadow-card bg-card text-foreground',
          icon: 'shrink-0 [&_svg]:size-4',
          content: 'min-w-0 flex-1 [[data-sonner-toast]:not(:has([data-icon]))_&]:col-start-1',
          title: 'text-base md:text-sm truncate',
          description: 'sr-only',
          // brand color を当てない。地の文字色 + hover の地色で「押せる」ことだけ示す
          actionButton:
            'shrink-0 -mr-1 cursor-pointer rounded-lg border-0 bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-state-hover md:text-xs',
          // 右上の角へ浮かせる。unstyled では sonner 側の位置 CSS が当たらないので、
          // 絶対配置は自前で書く。本文の行に入らないため幅を取らず、モバイルで文言が
          // 切れることもない。普段は透明で、ポインタが乗った時とフォーカス時だけ出す
          closeButton:
            '!absolute !top-0 !right-0 !left-auto flex !size-5 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
          loader: '!static !inset-auto !transform-none',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
