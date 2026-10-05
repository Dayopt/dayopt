export interface ActivitySummaryRecord {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  minutes: number;
  source: string;
}

export interface ActivitySummaryResult {
  startDate: string;
  endDate: string;
  recordedMinutes: number;
  medianBoxMinutes: number | null;
  totalRecordCount: number;
  records: ActivitySummaryRecord[];
}
