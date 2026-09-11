import { describe, expect, it, vi } from 'vitest';

import { REPORT_TIME_OF_DAY_BUCKETS } from '../lib/report-period';
import { createReportDetailService } from './report-detail-service';

import type { ReportFetchClient } from './report-fetchers';

vi.mock('server-only', () => ({}));

const TOKYO = 'Asia/Tokyo';
const USER_ID = 'user-1';
/** 2026-09-04（金）12:00 JST。週は 08-31（月）〜 09-07（月）。 */
const NOW = new Date('2026-09-04T03:00:00.000Z');

const BUCKET_INDEX = Object.fromEntries(
  REPORT_TIME_OF_DAY_BUCKETS.map((bucket, index) => [bucket.key, index]),
) as Record<(typeof REPORT_TIME_OF_DAY_BUCKETS)[number]['key'], number>;

interface RecordSeed {
  id: string;
  activity_id: string | null;
  start_at: string;
  end_at: string;
  title?: string;
  note?: string | null;
  fulfillment?: string | null;
  source?: string;
}

interface PlanSeed {
  id: string;
  activity_id: string | null;
  start_at: string;
  end_at: string;
}

/** `.eq` / `.is` / `.lt` / `.gt` を素朴に再現する fake（集計側の test と同じ形）。 */
function createFakeClient(seed: { records?: RecordSeed[]; plans?: PlanSeed[] }): ReportFetchClient {
  const tables: Record<string, Record<string, unknown>[]> = {
    records: (seed.records ?? []).map((row) => ({
      user_id: USER_ID,
      deleted_at: null,
      title: '記録',
      note: null,
      fulfillment: null,
      source: 'manual',
      ...row,
    })),
    plans: (seed.plans ?? []).map((row) => ({
      user_id: USER_ID,
      deleted_at: null,

      ...row,
    })),
  };

  function createQuery(rows: Record<string, unknown>[]) {
    let current = rows;
    const query = {
      select: () => query,
      order: () => query,
      range: () => query,
      eq: (column: string, value: unknown) => {
        current = current.filter((row) => row[column] === value);
        return query;
      },
      is: (column: string, value: unknown) => {
        current = current.filter((row) => row[column] === value);
        return query;
      },
      lt: (column: string, value: string) => {
        current = current.filter((row) => Date.parse(String(row[column])) < Date.parse(value));
        return query;
      },
      gt: (column: string, value: string) => {
        current = current.filter((row) => Date.parse(String(row[column])) > Date.parse(value));
        return query;
      },
      then: (
        resolve: (result: { data: Record<string, unknown>[]; error: null }) => unknown,
      ): unknown => resolve({ data: current, error: null }),
    };
    return query;
  }

  return {
    from: (table: string) => createQuery(tables[table] ?? []),
  } as unknown as ReportFetchClient;
}

function baseInput(
  overrides: Partial<
    Parameters<ReturnType<typeof createReportDetailService>['getActivityDetail']>[1]
  > = {},
) {
  return {
    activityId: 'act-1' as string | null,
    anchorDate: '2026-09-04',
    granularity: 'week' as const,
    timezone: TOKYO,
    weekStartsOn: 1 as const,
    includeTrend: true,
    ...overrides,
  };
}

/** JST の壁時計時刻を UTC ISO へ。 */
function jst(day: string, time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCHours((hour ?? 0) - 9, minute ?? 0, 0, 0);
  return date.toISOString();
}

function record(
  id: string,
  day: string,
  from: string,
  to: string,
  overrides: Partial<RecordSeed> = {},
) {
  return {
    id,
    activity_id: 'act-1',
    start_at: jst(day, from),
    end_at: jst(day, to),
    ...overrides,
  };
}

describe('ReportDetailService.getActivityDetail', () => {
  it('記録の合計・中央値・充実の分布を返す（平均は返さない）', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          record('r1', '2026-09-01', '10:00', '11:00', { fulfillment: 'high' }),
          record('r2', '2026-09-02', '10:00', '12:00', { fulfillment: 'low' }),
          record('r3', '2026-09-03', '10:00', '16:00'),
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.recordedMinutes).toBe(60 + 120 + 360);
    // 60 / 120 / 360 の中央値は 120（平均 180 ではない）
    expect(result.medianBoxMinutes).toBe(120);
    expect(result.fulfillment).toEqual({ low: 1, medium: 0, high: 1 });
  });

  it('箱が偶数個なら中央 2 つの平均を中央値として返す', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          record('r1', '2026-09-01', '10:00', '11:00'),
          record('r2', '2026-09-02', '10:00', '13:00'),
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.medianBoxMinutes).toBe(120);
  });

  it('記録が 0 件なら中央値は null（0 ではない）', async () => {
    const service = createReportDetailService(createFakeClient({}));

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.medianBoxMinutes).toBeNull();
    expect(result.records).toEqual([]);
    expect(result.recordedMinutes).toBe(0);
  });

  /** 仕様 §6-4。0 時またぎは日境界で分割してから按分する。 */
  it('時間帯の分布が 0 時またぎで夜と深夜へ分かれる', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          {
            id: 'r1',
            activity_id: 'act-1',
            start_at: jst('2026-09-02', '23:30'),
            end_at: jst('2026-09-03', '01:00'),
          },
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.timeOfDay[BUCKET_INDEX.evening]).toBe(30);
    expect(result.timeOfDay[BUCKET_INDEX.night]).toBe(60);
  });

  it('予定は過去ぶんだけ planPast に数える', async () => {
    const service = createReportDetailService(
      createFakeClient({
        plans: [
          // 09-02（過去）
          {
            id: 'p1',
            activity_id: 'act-1',
            start_at: jst('2026-09-02', '10:00'),
            end_at: jst('2026-09-02', '11:00'),
          },
          // 09-06（未来）
          {
            id: 'p2',
            activity_id: 'act-1',
            start_at: jst('2026-09-06', '10:00'),
            end_at: jst('2026-09-06', '12:00'),
          },
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.plannedMinutes).toBe(180);
    expect(result.plannedPastMinutes).toBe(60);
    expect(result.plannedPastBoxes).toBe(1);
  });

  it('明細は開始の昇順で、期間へ clip した長さを持つ', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          record('r-late', '2026-09-03', '10:00', '11:00'),
          record('r-early', '2026-09-01', '09:00', '09:30'),
          // 週の開始（08-31 00:00 JST）を跨ぐ記録。clip されて 60 分になる
          {
            id: 'r-cross',
            activity_id: 'act-1',
            start_at: jst('2026-08-30', '23:00'),
            end_at: jst('2026-08-31', '01:00'),
          },
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.records.map((row) => row.id)).toEqual(['r-cross', 'r-early', 'r-late']);
    expect(result.records[0]?.minutes).toBe(60);
  });

  /** 推移は表示中を含む直近 6 期間。1 回の取得を期間ごとに clip する。 */
  it('推移が古い順に 6 期間ぶん並ぶ', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          record('r-now', '2026-09-01', '10:00', '11:00'),
          // 2 週前（08-17〜08-24）
          record('r-old', '2026-08-19', '10:00', '13:00'),
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.trend).toHaveLength(6);
    expect(result.trend[3]?.recordedMinutes).toBe(180);
    expect(result.trend[5]?.recordedMinutes).toBe(60);
  });

  it('includeTrend: false なら推移を計算しない', async () => {
    const service = createReportDetailService(
      createFakeClient({ records: [record('r1', '2026-09-01', '10:00', '11:00')] }),
    );

    const result = await service.getActivityDetail(
      USER_ID,
      baseInput({ includeTrend: false }),
      NOW,
    );

    expect(result.trend).toEqual([]);
    expect(result.recordedMinutes).toBe(60);
  });

  it('auto_migrated の記録は合計に入るが中央値からは除く', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          record('r1', '2026-09-01', '10:00', '11:00'),
          record('r2', '2026-09-02', '10:00', '12:00'),
          // 自動移行の 6 時間。合計には入るが代表値は押し上げない
          record('r3', '2026-09-03', '10:00', '16:00', { source: 'auto_migrated' }),
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.recordedMinutes).toBe(60 + 120 + 360);
    // 60 / 120 の中央値。360 は数えない
    expect(result.medianBoxMinutes).toBe(90);
  });

  it('auto_migrated しか無ければ中央値は null', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [record('r1', '2026-09-01', '10:00', '11:00', { source: 'auto_migrated' })],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.recordedMinutes).toBe(60);
    expect(result.medianBoxMinutes).toBeNull();
  });

  it('明細は source を持ち、auto_migrated も残る', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          record('r1', '2026-09-01', '10:00', '11:00'),
          record('r2', '2026-09-02', '10:00', '11:00', { source: 'auto_migrated' }),
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.records.map((row) => row.source)).toEqual(['manual', 'auto_migrated']);
  });

  it('推移の各期間に中央値を持ち、記録の無い期間は null', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          record('r-now-1', '2026-09-01', '10:00', '11:00'),
          record('r-now-2', '2026-09-02', '10:00', '13:00'),
          // 2 週前（08-17〜08-24）に 1 件だけ
          record('r-old', '2026-08-19', '10:00', '13:00'),
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    // 表示中の週は 60 / 180 → 120
    expect(result.trend[5]?.medianBoxMinutes).toBe(120);
    expect(result.trend[3]?.medianBoxMinutes).toBe(180);
    expect(result.trend[4]?.medianBoxMinutes).toBeNull();
  });

  it('過去予定の中央値は now と期間で clip した長さで出す', async () => {
    const service = createReportDetailService(
      createFakeClient({
        plans: [
          // 60 分（過去）
          {
            id: 'p1',
            activity_id: 'act-1',
            start_at: jst('2026-09-02', '10:00'),
            end_at: jst('2026-09-02', '11:00'),
          },
          // 180 分（過去）
          {
            id: 'p2',
            activity_id: 'act-1',
            start_at: jst('2026-09-03', '10:00'),
            end_at: jst('2026-09-03', '13:00'),
          },
          // 実行中（11:00 開始、14:00 終了）。now = 12:00 なので 60 分ぶんだけ数える
          {
            id: 'p3',
            activity_id: 'act-1',
            start_at: jst('2026-09-04', '11:00'),
            end_at: jst('2026-09-04', '14:00'),
          },
          // 未来。数えない（数えると長い先の予定が見積もりを押し上げる）
          {
            id: 'p4',
            activity_id: 'act-1',
            start_at: jst('2026-09-06', '10:00'),
            end_at: jst('2026-09-06', '20:00'),
          },
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    // 60 / 180 / 60 の中央値
    expect(result.medianPlanBoxMinutes).toBe(60);
  });

  it('過去予定が無ければ予定の中央値は null', async () => {
    const service = createReportDetailService(
      createFakeClient({
        plans: [
          {
            id: 'p1',
            activity_id: 'act-1',
            start_at: jst('2026-09-06', '10:00'),
            end_at: jst('2026-09-06', '12:00'),
          },
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput(), NOW);

    expect(result.medianPlanBoxMinutes).toBeNull();
  });

  /** アクティビティ未設定の記録も明細を開ける（`.eq(null)` では引けない）。 */
  it('activityId が null ならアクティビティ未設定の記録を集める', async () => {
    const service = createReportDetailService(
      createFakeClient({
        records: [
          record('r-null', '2026-09-01', '10:00', '11:00', { activity_id: null }),
          record('r-act', '2026-09-01', '12:00', '13:00'),
        ],
      }),
    );

    const result = await service.getActivityDetail(USER_ID, baseInput({ activityId: null }), NOW);

    expect(result.records.map((row) => row.id)).toEqual(['r-null']);
    expect(result.recordedMinutes).toBe(60);
  });
});
