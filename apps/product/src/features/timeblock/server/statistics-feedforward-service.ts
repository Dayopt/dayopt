import 'server-only';

/**
 * 統計 service — 作成時フィードフォワード（タグ別見積もり係数）
 *
 * ADR-026（決定ログ（削除済み、git 履歴参照））の 1 点目。
 * 集計の定義は `domain/activity-estimation-factor.ts` が正本で、この層は行取得と分単位への
 * 変換だけを担う。
 */

import { toDerivedBlock } from '@/lib/database';
import { MS_PER_DAY } from '@/lib/date/constants';

import { aggregateActivityEstimationFactors, type ActivityEstimationFactor } from '../domain';

import { fetchPlansForEstimation, fetchRecords } from './statistics-fetchers';
import type { ServiceSupabaseClient } from './types';

/** ADR-026 の「直近 4 週」。`plans.start_at` の [now - 28 日, now) で切る。 */
export const ESTIMATION_WINDOW_DAYS = 28;

export class StatisticsFeedforwardService {
  constructor(private readonly supabase: ServiceSupabaseClient) {}

  /**
   * 直近 4 週の activity 別見積もり係数を返す。`n >= 3` の activity だけが含まれる。
   *
   * 期間は UTC の絶対時刻で切る。タイムゾーン境界に依存する「日」の集計ではなく
   * 「今から 28 日前まで」の窓なので、user timezone を引く必要が無い。
   *
   * メソッド名は procedure 名（`statistics.getTagEstimationFactors`）に合わせて維持している
   * （issue #2162 のコメント欄 step-5-7-completion.md §4-2 相当、#2473 で移設。procedure 名の改名は
   * 破壊的公開契約変更のため別 scope）。中身は activity 軸の集計を返す。
   */
  async getTagEstimationFactors(
    userId: string,
    now = new Date(),
  ): Promise<ActivityEstimationFactor[]> {
    const startDate = new Date(now.getTime() - ESTIMATION_WINDOW_DAYS * MS_PER_DAY).toISOString();
    const endDate = now.toISOString();
    const plans = await fetchPlansForEstimation(this.supabase, userId, { startDate, endDate });
    if (plans.length === 0) return [];

    const records = await fetchRecords(this.supabase, userId, { startDate, endDate });
    return aggregateActivityEstimationFactors(
      [
        ...plans.map((row) => toDerivedBlock(row, 'plan')),
        ...records.map((row) => toDerivedBlock(row, 'rec')),
      ],
      { startAt: startDate, endAt: endDate, timezone: 'UTC' },
      now,
    );
  }
}
