import { aggregate, type DerivedBlock, type DerivedPeriod } from './derived-model';

export interface ActivityEstimationFactor {
  activityId: string;
  factor: number;
  sampleCount: number;
}
const MIN_ESTIMATION_SAMPLE_COUNT = 3;
const PROJECTION_STEP_MINUTES = 5;

/** Independent period totals, never a median of paired observations. */
export function aggregateActivityEstimationFactors(
  blocks: readonly DerivedBlock[],
  period: DerivedPeriod,
  now: Date,
): ActivityEstimationFactor[] {
  const results: ActivityEstimationFactor[] = [];
  for (const activityId of new Set(blocks.map((block) => block.activityId))) {
    if (activityId === null) continue;
    const totals = aggregate(period, activityId, blocks, now);
    if (
      totals.plannedPastBoxes < MIN_ESTIMATION_SAMPLE_COUNT ||
      totals.plannedPastMinutes < 15 ||
      totals.recordedMinutes <= 0
    )
      continue;
    results.push({
      activityId,
      factor: totals.recordedMinutes / totals.plannedPastMinutes,
      sampleCount: totals.plannedPastBoxes,
    });
  }
  return results.sort(
    (a, b) => b.sampleCount - a.sampleCount || a.activityId.localeCompare(b.activityId),
  );
}

export function projectActualMinutes(factor: number, draftMinutes: number): number {
  const projected = factor * draftMinutes;
  const rounded = Math.round(projected / PROJECTION_STEP_MINUTES) * PROJECTION_STEP_MINUTES;
  return Math.max(PROJECTION_STEP_MINUTES, rounded);
}
