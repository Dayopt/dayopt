import type { PublicRecordRow, Row } from '@/lib/database';
import type { PlanFilter, RecordFilter } from '../schemas/timeblock';

export type PlanRow = Row<'plans'>;

export type RecordRow = PublicRecordRow;

export interface ListPlansOptions extends PlanFilter {
  userId: string;
}

export interface GetPlanByIdOptions {
  userId: string;
  planId: string;
}

export interface ListRecordsOptions extends RecordFilter {
  userId: string;
}

export interface GetRecordByIdOptions {
  userId: string;
  recordId: string;
}
