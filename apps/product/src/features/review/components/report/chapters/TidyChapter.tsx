'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@dayopt/components';

import { formatReportDuration } from '../../../domain/report/format-duration';

import type { ReportGranularity } from '../../../lib/report-period';

interface TidyChapterProps {
  granularity: ReportGranularity;
  /** 期間内の未分類の記録の件数。 */
  uncategorizedRecordCount: number;
  /** 未変換の外部カレンダー予定の件数。**期間に限定しない**（仕様 §4.4）。 */
  unconvertedExternalEventCount: number;
  /** 次期間に置かれている予定の合計（分）。 */
  nextPeriodPlannedMinutes: number;
  onSortUncategorized: () => void;
  onReviewExternalEvents: () => void;
  onOpenNextPeriod: () => void;
}

/**
 * 4 章「整える — そして来週へ」。
 *
 * 3 行固定。**締め・ロック・確定操作は作らない**（仕様 §4.4）。レポート面では作成も編集も
 * せず、他画面へのジャンプだけがアクション（仕様 §0-6）。
 *
 * 件数 0 の行はボタンを出さず `なし` を置く。責めない・催促しない（「〜しましょう」を書かない）。
 */
export function TidyChapter({
  granularity,
  uncategorizedRecordCount,
  unconvertedExternalEventCount,
  nextPeriodPlannedMinutes,
  onSortUncategorized,
  onReviewExternalEvents,
  onOpenNextPeriod,
}: TidyChapterProps) {
  const t = useTranslations('report.tidy');

  return (
    <section
      aria-label={t('kick')}
      data-report-chapter="tidy"
      className="border-border-subtle flex flex-col gap-4 border-b pb-8 last:border-b-0"
    >
      <h2 className="text-foreground text-sm font-medium">{t('kick')}</h2>

      <ul className="flex flex-col gap-2">
        <TidyRow
          actionLabel={t('uncategorized.action')}
          count={uncategorizedRecordCount}
          label={t('uncategorized.label', { count: uncategorizedRecordCount })}
          onAction={onSortUncategorized}
        />
        <TidyRow
          actionLabel={t('externalEvents.action')}
          count={unconvertedExternalEventCount}
          label={t('externalEvents.label', { count: unconvertedExternalEventCount })}
          onAction={onReviewExternalEvents}
        />
      </ul>

      <div className="border-border-subtle flex min-h-11 flex-wrap items-center gap-2 border-t pt-4">
        <p className="text-foreground min-w-0 flex-1 text-sm">
          {nextPeriodPlannedMinutes > 0
            ? t(`nextPeriod.planned.${granularity}`, {
                duration: formatReportDuration(nextPeriodPlannedMinutes),
              })
            : t(`nextPeriod.empty.${granularity}`)}
        </p>

        {/* size="sm" は 32px。テキストボタンには icon 変種のような 44px の疑似要素が
            付かないので、タッチターゲットは min-h-11 で明示する */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11"
          onClick={onOpenNextPeriod}
        >
          {t('nextPeriod.action')}
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </section>
  );
}

function TidyRow({
  actionLabel,
  count,
  label,
  onAction,
}: {
  actionLabel: string;
  count: number;
  label: string;
  onAction: () => void;
}) {
  const t = useTranslations('report.tidy');

  return (
    <li className="flex min-h-11 items-center gap-2">
      <span className="text-foreground min-w-0 flex-1 text-sm">{label}</span>

      {count > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11"
          onClick={onAction}
          aria-label={actionLabel}
        >
          {actionLabel}
        </Button>
      ) : (
        // 片付いている行にボタンを出さない。押せない導線を残すより、静かに「なし」と言う
        <span className="text-muted-foreground text-xs">{t('none')}</span>
      )}
    </li>
  );
}
