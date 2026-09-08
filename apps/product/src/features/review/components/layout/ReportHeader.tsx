'use client';

import { useTranslations } from 'next-intl';

import { AppHeader } from '@/components/shell/AppHeader';
import { DateRangeDisplay } from '@/components/ui/display/DateRangeDisplay';
import { DateNavigator } from '@/components/ui/navigation/DateNavigator';

import { ReportGranularitySwitcher } from './ReportGranularitySwitcher';

import type { ReportGranularity, ReportWeekStartsOn } from '../../lib/report-period';

interface ReportHeaderProps {
  /** 期間の先頭日（壁時計）。期間ラベルの起点。 */
  periodStart: Date;
  /** 期間の末尾日（壁時計、含む）。週なら 7 日目、月なら月末。 */
  periodEnd: Date;
  granularity: ReportGranularity;
  weekStartsOn: ReportWeekStartsOn;
  onNavigate: (direction: 'prev' | 'next' | 'today') => void;
  onGranularityChange: (granularity: ReportGranularity) => void;
  /**
   * サイドバーが閉じている時のトグル等。shell 側の `AppHeader` を使わなくなる代わりに、
   * Composition Layer が同じものを差し込む。
   */
  leftSlot?: React.ReactNode | undefined;
  rightSlot?: React.ReactNode | undefined;
}

/**
 * `/report` のヘッダー（デスクトップ）。
 *
 * カレンダーと**同じ器と同じ部品**で組む: 共有シェルの `AppHeader` に、共有層の
 * `DateRangeDisplay`（期間ラベル）と `DateNavigator`（`‹ ›` + 今日）を差し込む。
 * 並ぶ順序と余白もカレンダーの中央グループに揃える（2026-09-07 User 指示）。
 *
 * 粒度切替だけがレポート固有だが、器はカレンダーの `ViewSwitcher` と同じ
 * `h-8` の outline トリガー + `DropdownMenu` にする（2026-09-07 User 指示）。
 * 以前はセグメントだったが、1 項目が `min-h-11` で枠込み 54px あり、32px の行から
 * はみ出してレポートのヘッダーだけ厚く見えていた。
 *
 * `features/calendar` は同層なので import できない。期間の移動や粒度の変更は
 * すべて props のコールバックで Composition Layer へ返す。
 */
export function ReportHeader({
  periodStart,
  periodEnd,
  granularity,
  weekStartsOn,
  onNavigate,
  onGranularityChange,
  leftSlot,
  rightSlot,
}: ReportHeaderProps) {
  const t = useTranslations('report');

  return (
    <AppHeader {...(leftSlot ? { leftSlot } : {})} rightSlot={rightSlot}>
      {/* 並び・余白はカレンダーの中央グループと同値にする（`gap-2` + switcher に `ml-2`）。
          期間ラベル → `‹ 今日 ›` → 粒度を左に固めて 1 つのまとまりに読ませる —
          粒度だけ右端に置くと、面を移るたびに目線が横断する（2026-09-07 User 指示） */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DateRangeDisplay
          date={periodStart}
          {...(granularity === 'week' ? { endDate: periodEnd } : {})}
          weekStartsOn={weekStartsOn}
          formatPattern={resolveFormatPattern(granularity)}
        />
        <div className="flex shrink-0 items-center gap-4">
          <DateNavigator
            onNavigate={onNavigate}
            todayLabel={t(`nav.current.${granularity}`)}
            arrowSize="md"
          />
          <ReportGranularitySwitcher value={granularity} onValueChange={onGranularityChange} />
        </div>
      </div>
    </AppHeader>
  );
}

/**
 * 粒度ごとの期間ラベル。
 *
 * 週は `endDate` を渡して `DateRangeDisplay` の範囲テキスト（`8/17 – 8/23`、年をまたぐ
 * ときだけ年が付く）に任せるため、ここでのパターンは使われない。月は「2026年9月」、
 * 年は「2026年」を出す。
 */
function resolveFormatPattern(granularity: ReportGranularity): string {
  return granularity === 'year' ? 'yyyy' : 'MMMM yyyy';
}
