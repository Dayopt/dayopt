'use client';

import { useState } from 'react';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ConfirmDialog } from '@/components/ui/overlays/confirm-dialog';
import { formatTimeRange } from '@/lib/date';
import type { TimeFormat } from '@/lib/time';
import { cn } from '@dayopt/components';

import {
  MIN_CARD_HEIGHT_PX,
  type ExternalEventPosition,
} from '../../../../../lib/external-event-layout';

/**
 * 外部カレンダーの予定を表すカード（ghost）。
 *
 * `PlanLaneCard` の亜種だが別コンポーネントにしてある。ghost はタグも記録状態も持たず、
 * `PlanEvent` を組もうとすると偽の値を埋めることになるため。
 *
 * **`onConvert` / `onDismiss` を渡した時だけ操作可能になる**（#1985, #1984）。省略時は従来通り
 * 読み取り専用（`TwoLaneTimeblockRenderer` を通らないため、時刻の規則
 * （docs/product/specs/plan-record.md §時刻の規則）とはそもそも交差しない）。
 *
 * - **カード全体のタップ = 変換**（`onConvert`）。Plan / Record どちらに変換されるかは
 *   呼び出し側（`useConvertGhostEvent`）が `event.endDate` と現在時刻だけで一意に決める
 *   （メニューを出さない）。**この card 自身は `Date.now()` を render 中に呼ばない**
 *   （`react-hooks/purity` が禁止する。「Plan / Record どちらになるか」を aria-label に
 *   出し分ける代わりに、時間帯を問わない汎用の hint テキストだけを添える）
 * - **dismiss は隅の小アイコンで別ジェスティア**（`stopPropagation` で変換タップと衝突しない）。
 *   ConfirmDialog を挟む（design-system.md の確認フロー表で「アーカイブ」に該当するため、
 *   toast undo ではなく確認ダイアログを使う判断は #1985 plan review 参照）
 *
 * 視覚区別に塗りを使わないのは、`PlanLaneCard` が `bg-transparent` だから。ghost に背景色を敷くと
 * 上に重なる plan カードの中身の背景として透け、plan が ghost に飲まれて見える。破線も未記録 plan の
 * シグナルとして使用済みなので、左のインジケータ線と減光で区別する。
 */

const DETAIL_HEIGHT_THRESHOLD = 40;

interface ExternalEventCardProps {
  event: {
    id: string;
    title: string | null;
    calendarName: string | null;
    startDate: Date;
    endDate: Date;
  };
  position: ExternalEventPosition;
  timeFormat?: TimeFormat;
  compact?: boolean;
  className?: string;
  /** 変換（Plan または Record へのワンタップ変換）。省略時はカード全体が読み取り専用のまま。 */
  onConvert?: (() => void) | undefined;
  /** dismiss の確認ダイアログを確定した時の実行（非同期可）。省略時は dismiss アイコンを描かない。 */
  onDismiss?: (() => void | Promise<void>) | undefined;
}

export function ExternalEventCard({
  event,
  position,
  timeFormat = '24h',
  compact = false,
  className,
  onConvert,
  onDismiss,
}: ExternalEventCardProps) {
  const t = useTranslations('calendar.external');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const displayTitle = event.title ?? t('untitled');
  // 時刻を出すかは縦に入るかだけで決める。狭い列（compact）でも高さがあるカードから
  // 時刻が消えていて、何時のブロックか読めなかった（2026-09-07 User 指摘）
  const showDetails = position.height >= DETAIL_HEIGHT_THRESHOLD;
  const interactive = onConvert !== undefined;

  return (
    <div
      data-external-event-card
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
      className={cn(
        'border-border-subtle absolute flex flex-col gap-1 overflow-hidden rounded-lg border text-xs',
        'border-l-indicator border-l-border',
        interactive ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none',
        interactive &&
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        compact ? 'px-2' : 'px-3',
        // 高さが足りないカードだけ上下を詰める（詰めないと文字が切れる）
        showDetails ? 'py-2' : 'py-1',
        // 自分の計画より一段沈める。plan の skip(50%) / 記録済み(60%) とは別のレンジに置き、
        // 「Dayopt の外にある予定」として読ませる。
        'text-muted-foreground bg-transparent opacity-75',
        className,
      )}
      style={{
        top: `${position.top}px`,
        left: `${position.left}%`,
        width: `calc(${position.width}% - 4px)`,
        // 選択カレンダー数が多い週表示などで重複が増えると `position.width` が数 % まで
        // 縮む。固定 4px を引くと `width` が 0 以下になり不可視化するため、`min-width` で
        // 必ず見える幅を保証する（`width: max(4px, calc(...))` は避ける — テスト環境の
        // happy-dom が inline style の CSS `max()` を解釈できず style 自体が丸ごと無視される）。
        minWidth: '4px',
        height: `${Math.max(position.height, MIN_CARD_HEIGHT_PX)}px`,
      }}
      onClick={interactive ? onConvert : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onConvert?.();
              }
            }
          : undefined
      }
    >
      <p className="truncate font-medium">
        <span className="sr-only">{t('screenReaderPrefix')}</span>
        {displayTitle}
        {interactive && <span className="sr-only">, {t('convert.hint')}</span>}
      </p>
      {showDetails && (
        <p className="truncate">
          {formatTimeRange(position.displayStartDate, position.displayEndDate, timeFormat)}
          {event.calendarName ? ` · ${event.calendarName}` : ''}
        </p>
      )}

      {onDismiss && (
        <>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:bg-state-hover pointer-events-auto absolute top-1 right-1 rounded-full p-1"
            aria-label={t('dismiss.ariaLabel')}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmOpen(true);
            }}
          >
            <X className="size-3.5" />
          </button>

          <ConfirmDialog
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            onConfirm={async () => {
              await onDismiss();
            }}
            title={t('dismiss.confirmTitle')}
            description={t('dismiss.confirmDescription')}
            confirmLabel={t('dismiss.confirmLabel')}
            loadingLabel={t('dismiss.loadingLabel')}
            variant="default"
          />
        </>
      )}
    </div>
  );
}
