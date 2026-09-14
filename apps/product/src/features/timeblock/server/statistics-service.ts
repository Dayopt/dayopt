import 'server-only';

/**
 * Step 4: 統計 TS service。
 *
 * Step 0 の Aggregation Source Contract（旧 `docs/projects/_archive/time-model-split/step-0-statistics-rpc-policy.md`、
 * docs/projects 全廃に伴い #2473 で削除。git 履歴参照）
 * に従い、実績系は `records`、予定系は `plans` を読む。
 *
 * 統計 procedure（`getActivityStats` / `getTagEstimationFactors`）はこのクラス経由で動く。
 * PL/pgSQL の統計 RPC は呼ばれていない。呼び出し元の無かった分布・KPI・streak 系の
 * procedure は #2624 で削除した。
 *
 * 公開 API は facade（このファイル）。実装はドメイン単位の service に分割されている:
 * - General（アクティビティ別統計）: statistics-general-service.ts
 * - Feedforward（見積もり係数）: statistics-feedforward-service.ts
 * - 行取得: statistics-fetchers.ts
 */

import { StatisticsFeedforwardService } from './statistics-feedforward-service';
import { StatisticsGeneralService } from './statistics-general-service';
import type { ServiceSupabaseClient } from './types';

export class StatisticsService {
  private readonly feedforwardService: StatisticsFeedforwardService;
  private readonly generalService: StatisticsGeneralService;

  constructor(supabase: ServiceSupabaseClient) {
    this.feedforwardService = new StatisticsFeedforwardService(supabase);
    this.generalService = new StatisticsGeneralService(supabase);
  }

  /** アクティビティ別の実績件数・最終使用日・記録の長さの中央値（キーは activityId）。 */
  async getActivityStats(userId: string, now = new Date()) {
    return this.generalService.getActivityStats(userId, now);
  }

  /**
   * 作成時フィードフォワード用のタグ別見積もり係数（直近 4 週の期間合計比、`n >= 3`）。
   * 定義は `domain/activity-estimation-factor.ts` を参照。
   */
  async getTagEstimationFactors(userId: string) {
    return this.feedforwardService.getTagEstimationFactors(userId);
  }
}
