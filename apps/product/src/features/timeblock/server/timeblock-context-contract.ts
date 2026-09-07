import { z } from 'zod';

export const TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE = 5_000;
export const TIMEBLOCK_CONTEXT_MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;
const timeblockContextDateTimeSchema = z.string().datetime({ offset: true });

export const timeblockContextRangeSchema = z
  .object({
    startDate: timeblockContextDateTimeSchema,
    endDate: timeblockContextDateTimeSchema,
  })
  .strict()
  .superRefine((range, context) => {
    const start = Date.parse(range.startDate);
    const end = Date.parse(range.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;

    if (start >= end) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endDate must be after startDate',
        path: ['endDate'],
      });
      return;
    }

    if (end - start > TIMEBLOCK_CONTEXT_MAX_RANGE_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Date range must not exceed 31 days',
        path: ['endDate'],
      });
    }
  });

export function isTimeblockDateTime(value: string): boolean {
  return timeblockContextDateTimeSchema.safeParse(value).success;
}

export type TimeblockContextRange = z.infer<typeof timeblockContextRangeSchema>;

export interface TimeblockContextOccupancy {
  startAt: string;
  endAt: string;
}

export interface TimeblockConstraints {
  asOf: string;
  timezone: string;
  range: TimeblockContextRange & { endExclusive: true };
  completeness: {
    complete: true;
    maxItemsPerLane: typeof TIMEBLOCK_CONTEXT_MAX_ITEMS_PER_LANE;
  };
  occupancy: {
    plans: TimeblockContextOccupancy[];
    records: TimeblockContextOccupancy[];
  };
  rules: typeof TIMEBLOCK_CONTEXT_RULES;
}

export const TIMEBLOCK_CONTEXT_RULES = {
  intervalBoundary: '[)',
  overlap: {
    planVsPlan: 'forbidden',
    recordVsRecord: 'forbidden',
    planVsRecord: 'allowed',
  },
  plans: {
    createEnd: 'unrestricted',
    pastPlanTimeUpdate: 'allowed',
    pastPlanContentUpdate: 'allowed',
    timeUpdateEnd: 'unrestricted',
  },
  records: {
    createEnd: 'at_or_before_as_of',
    timeUpdateEnd: 'at_or_before_as_of',
  },
} as const;
