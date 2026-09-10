'use client';

/**
 * 作成時フィードフォワード（ADR-026 の 1 点目）
 *
 * 「このアクティビティの直近の記録は 45m 前後です」を Plan の作成・編集時に出す。
 * 日時グルーピングの直上にバッジとして置く（2026-09-10 User 指示。「結構強い情報」
 * という位置づけへ改め、本文に紛れる 1 行から独立したバッジへ変えた）。
 *
 * 強めるのは配置と形だけで、警告色・アイコン・感嘆符は引き続き使わない。
 * ユーザーの入力を書き換えることも無く、読むかどうかはユーザーに委ねる
 * （strategy §4-6 成績表化しない）。
 *
 * 出さない条件（どれか 1 つでも該当したら `null`）:
 * - 保存先が Record（過去の事実の記録に見積もりの話は要らない）
 * - activity 未選択
 * - draft の長さが 0 以下
 * - その activity のサンプルが 3 件未満、または係数を取得できていない
 */

import { useTranslations } from 'next-intl';

import { formatDurationMinutes } from '@/lib/date';
import { Badge } from '@dayopt/components';

import type { TimeblockDestination } from '../../domain/timeblock-destination';
import { useTagEstimationFactors } from '../../hooks/useTagEstimationFactors';

interface EstimationFeedforwardProps {
  /** 保存先。`'plan'` のときだけ表示する。 */
  destination: TimeblockDestination;
  activityId: string | null;
  /** draft の予定時間（分）。 */
  draftMinutes: number;
}

export function EstimationFeedforward({
  destination,
  activityId,
  draftMinutes,
}: EstimationFeedforwardProps) {
  const t = useTranslations('timeblock.editor.feedforward');
  const { project } = useTagEstimationFactors();

  if (destination !== 'plan') return null;

  const projection = project(activityId, draftMinutes);
  if (!projection) return null;

  return (
    // whitespace-normal: 既定の nowrap だと日本語の文がパネル幅を超える
    <Badge variant="info" className="whitespace-normal" role="status">
      {t('recentActual', { duration: formatDurationMinutes(projection.minutes) })}
    </Badge>
  );
}
