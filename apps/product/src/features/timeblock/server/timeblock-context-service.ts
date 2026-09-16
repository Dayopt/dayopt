import {
  readCompleteTimeblockPages,
  readStableTimeblockSnapshot,
} from './timeblock-consistent-read';
import {
  createTimeblockContextClient,
  type TimeblockContextMarker,
  type TimeblockContextOccupancyRow,
  type TimeblockContextReadClient,
} from './timeblock-context-client';
import {
  TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE,
  TIMEBLOCK_CONTEXT_RULES,
  type TimeblockConstraints,
  type TimeblockContextOccupancy,
  type TimeblockContextRange,
} from './timeblock-context-contract';
import { TimeblockServiceError } from './timeblock-service-error';

const TIMEBLOCK_CONTEXT_PAGE_SIZE = 1_000;

class TimeblockContextService {
  constructor(private readonly contextClient: TimeblockContextReadClient) {}

  getMarker(userId: string, signal?: AbortSignal): Promise<TimeblockContextMarker> {
    return this.contextClient.getMarker(userId, signal);
  }

  async getConstraints(
    userId: string,
    range: TimeblockContextRange,
    requestSignal?: AbortSignal,
  ): Promise<TimeblockConstraints> {
    const {
      marker,
      data: [plans, records],
    } = await readStableTimeblockSnapshot({
      userId,
      subject: 'context',
      requestSignal,
      getMarker: (markerUserId, signal) => this.getMarker(markerUserId, signal),
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
        'Timeblock context range contains too many items',
      );
    }

    return {
      asOf: marker.databaseNow,
      timezone: marker.timezone,
      range: {
        ...range,
        endExclusive: true,
      },
      completeness: {
        complete: true,
        maxItemsPerLane: TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE,
      },
      occupancy: {
        plans: toPublicOccupancy(plans),
        records: toPublicOccupancy(records),
      },
      rules: TIMEBLOCK_CONTEXT_RULES,
    };
  }

  private async listLane(
    userId: string,
    lane: 'plans' | 'records',
    range: TimeblockContextRange,
    signal: AbortSignal,
  ): Promise<TimeblockContextOccupancyRow[]> {
    return readCompleteTimeblockPages({
      subject: 'occupancy',
      maxItems: TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE,
      pageSize: TIMEBLOCK_CONTEXT_PAGE_SIZE,
      signal,
      readPage: (offset, limit) =>
        this.contextClient.listOccupancyPage(
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

export function createTimeblockContextService(): TimeblockContextService {
  return new TimeblockContextService(createTimeblockContextClient());
}

function toPublicOccupancy(rows: TimeblockContextOccupancyRow[]): TimeblockContextOccupancy[] {
  return rows.map(({ startAt, endAt }) => ({ startAt, endAt }));
}
