import 'server-only';

/**
 * Step 4: 統計 TS service。
 *
 * Step 0 の Aggregation Source Contract（旧 `docs/projects/_archive/time-model-split/step-0-statistics-rpc-policy.md`、
 * docs/projects 全廃に伴い #2473 で削除。git 履歴参照）
 * に従い、実績系は `records`、予定系は `plans`、予実比較は独立した期間合計を読む。
 *
 * Step 8 のカットオーバーは完了済みで、**統計 procedure はすべてこのクラス経由**で動く
 * （`statistics-general-router.ts` / `statistics-kpi-router.ts` / `statistics-summary-router.ts`
 * の全 procedure が `new StatisticsService(ctx.supabase)` を呼ぶ）。PL/pgSQL の統計 RPC は
 * 呼ばれていない。
 *
 * 公開 API は facade（このファイル）。実装はドメイン単位の service に分割されている:
 * - General（タグ別統計・時間帯分布・トレンド）: statistics-general-service.ts
 * - KPI（見積もり精度・空白率）: statistics-kpi-service.ts
 * - Summary（streak / KPI サマリー）: statistics-summary-service.ts
 * - 行取得: statistics-fetchers.ts / 集計の下ごしらえ: statistics-service-grouping.ts
 */

import { StatisticsFeedforwardService } from './statistics-feedforward-service';
import type { DateRangeInput } from './statistics-fetchers';
import { StatisticsGeneralService } from './statistics-general-service';
import type { BlankRateInput } from './statistics-kpi-service';
import { StatisticsKpiService } from './statistics-kpi-service';
import { StatisticsSummaryService } from './statistics-summary-service';
import type { ServiceSupabaseClient } from './types';

export class StatisticsService {
  private readonly feedforwardService: StatisticsFeedforwardService;
  private readonly generalService: StatisticsGeneralService;
  private readonly kpiService: StatisticsKpiService;
  private readonly summaryService: StatisticsSummaryService;

  constructor(supabase: ServiceSupabaseClient) {
    this.feedforwardService = new StatisticsFeedforwardService(supabase);
    this.generalService = new StatisticsGeneralService(supabase);
    this.kpiService = new StatisticsKpiService(supabase);
    this.summaryService = new StatisticsSummaryService(supabase);
  }

  // ---------------------------------------------------------------------------
  // General: アクティビティ別統計・時間帯分布
  // ---------------------------------------------------------------------------

  /** アクティビティ別の実績件数・最終使用日・記録の長さの中央値（キーは activityId）。 */
  async getActivityStats(userId: string, now = new Date()) {
    return this.generalService.getActivityStats(userId, now);
  }

  /** `get_daily_hours` 相当。指定年の日別実績時間（ヒートマップ用）。 */
  async getDailyHours(userId: string, year: number) {
    return this.generalService.getDailyHours(userId, year);
  }

  /** `get_hourly_distribution` 相当。 */
  async getHourlyDistribution(userId: string, range: DateRangeInput = {}) {
    return this.generalService.getHourlyDistribution(userId, range);
  }

  /** `get_dow_distribution` 相当。 */
  async getDayOfWeekDistribution(userId: string, range: DateRangeInput = {}) {
    return this.generalService.getDayOfWeekDistribution(userId, range);
  }

  /** `get_monthly_hours` 相当。 */
  async getMonthlyTrend(userId: string, months = 12) {
    return this.generalService.getMonthlyTrend(userId, months);
  }

  // ---------------------------------------------------------------------------
  // KPI: 見積もり精度・空白率
  // ---------------------------------------------------------------------------

  /**
   * `get_estimation_accuracy` 相当。独立した予定・記録の期間合計比。
   * 詳細は `domain/estimation-accuracy.ts` の `aggregatePlanRecordEstimationAccuracy` を参照。
   */
  async getEstimationAccuracy(userId: string, range: DateRangeInput = {}) {
    return this.kpiService.getEstimationAccuracy(userId, range);
  }

  /** `get_blank_rate` 相当。予定（plans）ベースのスケジュール時間から空白率を算出する。 */
  async getBlankRate(userId: string, input: BlankRateInput) {
    return this.kpiService.getBlankRate(userId, input);
  }

  /**
   * 作成時フィードフォワード用のタグ別見積もり係数（直近 4 週の期間合計比、`n >= 3`）。
   * 定義は `domain/activity-estimation-factor.ts` を参照。
   */
  async getTagEstimationFactors(userId: string) {
    return this.feedforwardService.getTagEstimationFactors(userId);
  }

  // ---------------------------------------------------------------------------
  // Summary: streak / KPI サマリー
  // ---------------------------------------------------------------------------

  /** `get_active_dates` 相当。実績（records）が存在する日付（tz basis）の一覧。 */
  async getActiveDates(userId: string, startDate: string) {
    return this.summaryService.getActiveDates(userId, startDate);
  }

  /** `get_stats_kpi_summary` 相当。 */
  async getStatsOverview(userId: string, input: BlankRateInput) {
    return this.summaryService.getStatsOverview(userId, input);
  }
}
