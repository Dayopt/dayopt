import type { TimePLReview } from '../domain';

import type { TimeblockContextRange } from './timeblock-context-contract';

export const TIMEBLOCK_REVIEW_MAX_ACTIVITIES = 1_000;

export const TIMEBLOCK_REVIEW_BASIS = {
  planMeaning: 'budget',
  recordMeaning: 'actual',
  // タグ有無で絞らない。未分類の行も単一バケットとして集計に含める（#1576）
  rowFilter: 'active_overlapping_period',
  durationBoundary: 'clipped_to_period',
  periodBoundary: '[)',
  varianceConvention: 'planned_minus_recorded',
} as const;

export interface TimeblockMcpReview extends TimePLReview {
  asOf: string;
  period: TimeblockContextRange & {
    endExclusive: true;
    timezone: string;
  };
  basis: typeof TIMEBLOCK_REVIEW_BASIS;
}
