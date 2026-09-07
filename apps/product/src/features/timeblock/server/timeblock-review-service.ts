import { deriveTimePLReview } from '../domain';

import {
  readCompleteTimeblockPages,
  readStableTimeblockSnapshot,
} from './timeblock-consistent-read';
import {
  TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE,
  type TimeblockContextRange,
} from './timeblock-context-contract';
import {
  createTimeblockReviewClient,
  type TimeblockReviewReadClient,
  type TimeblockReviewRow,
} from './timeblock-review-client';
import {
  TIMEBLOCK_REVIEW_BASIS,
  TIMEBLOCK_REVIEW_MAX_ACTIVITIES,
  type TimeblockMcpReview,
} from './timeblock-review-contract';
import { TimeblockServiceError } from './timeblock-service-error';

const TIMEBLOCK_REVIEW_PAGE_SIZE = 1_000;

class TimeblockReviewService {
  constructor(private readonly reviewClient: TimeblockReviewReadClient) {}

  async getMcpReview(
    userId: string,
    range: TimeblockContextRange,
    requestSignal?: AbortSignal,
  ): Promise<TimeblockMcpReview> {
    const {
      marker,
      data: [plans, records],
    } = await readStableTimeblockSnapshot({
      userId,
      subject: 'review',
      requestSignal,
      getMarker: (markerUserId, signal) => this.reviewClient.getMarker(markerUserId, signal),
      read: (signal) =>
        Promise.all([
          this.listLane(userId, 'plans', range, signal),
          this.listLane(userId, 'records', range, signal),
        ]),
    });

    if (
      plans.length > TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE ||
      records.length > TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE
    ) {
      throw new TimeblockServiceError(
        'RANGE_TOO_DENSE',
        'Timeblock review range contains too many items',
      );
    }

    const review = deriveTimePLReview(
      plans,
      records,
      { startAt: range.startDate, endAt: range.endDate, timezone: marker.timezone },
      new Date(marker.databaseNow),
    );
    if (review.activities.length > TIMEBLOCK_REVIEW_MAX_ACTIVITIES) {
      throw new TimeblockServiceError(
        'RANGE_TOO_DENSE',
        'Timeblock review range contains too many distinct activities',
      );
    }

    return {
      asOf: marker.databaseNow,
      period: {
        ...range,
        endExclusive: true,
        timezone: marker.timezone,
      },
      basis: TIMEBLOCK_REVIEW_BASIS,
      ...review,
    };
  }

  private async listLane(
    userId: string,
    lane: 'plans' | 'records',
    range: TimeblockContextRange,
    signal: AbortSignal,
  ): Promise<TimeblockReviewRow[]> {
    return readCompleteTimeblockPages({
      subject: 'review',
      maxItems: TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE,
      pageSize: TIMEBLOCK_REVIEW_PAGE_SIZE,
      signal,
      readPage: (offset, limit) =>
        this.reviewClient.listReviewPage(
          {
            userId,
            lane,
            startDate: range.startDate,
            endDate: range.endDate,
            offset,
            limit,
          },
          signal,
        ),
    });
  }
}

export function createTimeblockReviewService(): TimeblockReviewService {
  return new TimeblockReviewService(createTimeblockReviewClient());
}
