import 'server-only';

/**
 * 統計 service — General: アクティビティ別統計
 */

import { MS_PER_DAY } from '@/lib/date/constants';

import {
  aggregateActivityMedianDurations,
  aggregateActivityPlanCounts,
  aggregateActivityStats,
  MEDIAN_DURATION_WINDOW_DAYS,
} from '../domain';

import { fetchPlans, fetchRecords } from './statistics-fetchers';
import type { ServiceSupabaseClient } from './types';

export class StatisticsGeneralService {
  constructor(private readonly supabase: ServiceSupabaseClient) {}

  /**
   * アクティビティ別の実績件数・最終使用日 + Plan 側の件数 + 記録の長さの中央値。
   *
   * サイドバーの削除確認分岐がこれを引く。`counts` は records ベース、
   * `planCounts` は Plan 側を別 Record で返す。アクティビティ削除は Plan / Record
   * の両方を「アクティビティなし」にするため、呼び出し側は両方の合計を
   * 「削除で未分類になる件数」として扱う（#1576 フォローアップ）。
   *
   * `medianMinutes` は作成パネルの目安表示とサイドバータップの既定長が使う。
   * 全履歴の records は既にここで引いているので、直近の窓へ絞るだけで追加の
   * DB 読みは無い（サイドバーは既にこの procedure を引いている）。
   */
  async getActivityStats(
    userId: string,
    now = new Date(),
  ): Promise<{
    counts: Record<string, number>;
    planCounts: Record<string, number>;
    lastUsed: Record<string, string>;
    /** activityId → 記録の長さの中央値（分）。`n >= 3` のアクティビティだけが入る */
    medianMinutes: Record<string, number>;
  }> {
    const [records, plans] = await Promise.all([
      fetchRecords(this.supabase, userId),
      fetchPlans(this.supabase, userId),
    ]);

    const byActivity = new Map<string, { count: number; lastUsed: string | null }>();
    for (const record of records) {
      if (record.activity_id == null) continue;
      const acc = byActivity.get(record.activity_id) ?? { count: 0, lastUsed: null };
      acc.count += 1;
      if (acc.lastUsed == null || record.start_at > acc.lastUsed) acc.lastUsed = record.start_at;
      byActivity.set(record.activity_id, acc);
    }

    const rows = Array.from(byActivity.entries()).map(([activityId, v]) => ({
      groupKey: activityId,
      record_count: v.count,
      last_used: v.lastUsed,
    }));

    const planRows = plans
      .filter((plan): plan is typeof plan & { activity_id: string } => plan.activity_id != null)
      .map((plan) => ({ groupKey: plan.activity_id }));

    // 期間の切り出しはここで行う（`fetchRecords` に range を渡すと窓の境界に跨る
    // record が clip され、そのアクティビティの「実際の長さ」ではなくなる。
    // テンプレート適用側は期間内の埋まり方を見るので clip したままでよい）
    const windowStart = now.getTime() - MEDIAN_DURATION_WINDOW_DAYS * MS_PER_DAY;
    const recentRecords = records.filter((record) => Date.parse(record.end_at) > windowStart);

    return {
      ...aggregateActivityStats(rows),
      planCounts: aggregateActivityPlanCounts(planRows),
      medianMinutes: Object.fromEntries(aggregateActivityMedianDurations(recentRecords)),
    };
  }
}
