export { aggregateDayOfWeekDistribution } from './day-of-week-distribution';
export {
  aggregatePlanRecordEstimationAccuracy,
  transformEstimationAccuracy,
} from './estimation-accuracy';
export type {
  EstimationAccuracyActivityLookup,
  EstimationAccuracyDbRow,
} from './estimation-accuracy';
export { aggregateHourlyDistribution } from './hourly-distribution';
export { aggregateMonthlyTrend, getMonthlyStartDate } from './monthly-trend';
export { calculateStreak } from './streak-calculator';

// MIN_ESTIMATION_SAMPLE_COUNT / projectActualMinutes は barrel に出さない。
// consumer（hook / test）が leaf を直接参照しており barrel 経由の consumer がいないため
// （AGENTS.md / `pr-cross-review` skill の「barrel 経由の consumer が実際にいるか」で判断）。
export { aggregateActivityEstimationFactors } from './activity-estimation-factor';
export type { ActivityEstimationFactor } from './activity-estimation-factor';
export { aggregateActivityPlanCounts, aggregateActivityStats } from './activity-stats';
export {
  MEDIAN_DURATION_WINDOW_DAYS,
  aggregateActivityMedianDurations,
} from './plan-template-duration';
export { deriveTimePLReview } from './time-pl-review';
export type { TimePLReview } from './time-pl-review';
