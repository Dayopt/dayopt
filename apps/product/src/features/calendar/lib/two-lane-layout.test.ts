import { describe, expect, it } from 'vitest';

import type { PlanEvent, RecordEvent } from '@/features/timeblock';
import {
  calculateTwoLaneLayout,
  DEFAULT_PLAN_LANE_WIDTH_PERCENT,
  hasLaneCounterpart,
  resolveTwoLaneFromPointer,
} from './two-lane-layout';

const HOUR_HEIGHT = 60;

/**
 * `displayStartDate`/`displayEndDate` は `convertToTimezone`（`toZonedTime`）で
 * 既に対象タイムゾーンの wall-clock 値へ変換済みの Date を想定する。
 * `calculateTwoLaneLayout` はその wall-clock 値を `getHours()`/`getMinutes()`
 * （実行環境のローカル TZ 依存）で読むため、テストでは UTC ISO 文字列ではなく
 * ローカルコンポーネント指定の `new Date(y, m, d, h, min)` で構築する
 * （実行環境の TZ に関わらず意図した時刻を再現するため）。
 */
function localDate(hour: number, minute: number, day = 10): Date {
  return new Date(2026, 6, day, hour, minute, 0, 0);
}

function makePlan(overrides: Partial<PlanEvent> = {}): PlanEvent {
  const start = localDate(9, 0);
  const end = localDate(10, 0);
  return {
    id: 'plan-1',
    title: 'Deep Work',
    note: null,
    activityId: null,
    startDate: start,
    endDate: end,
    displayStartDate: start,
    displayEndDate: end,
    duration: 60,
    status: 'upcoming',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<RecordEvent> = {}): RecordEvent {
  const start = localDate(9, 0);
  const end = localDate(10, 0);
  return {
    id: 'record-1',
    title: 'Deep Work',
    note: null,
    activityId: null,
    startDate: start,
    endDate: end,
    displayStartDate: start,
    displayEndDate: end,
    duration: 60,
    ...overrides,
  };
}

describe('calculateTwoLaneLayout', () => {
  it('Plan は左レーン(left=0)、Record は右レーン(left=planLaneWidthPercent)に配置する', () => {
    const result = calculateTwoLaneLayout({
      plans: [makePlan()],
      records: [makeRecord()],
      hourHeight: HOUR_HEIGHT,
    });

    expect(result.planLayouts[0]?.position.left).toBe(0);
    expect(result.planLayouts[0]?.position.width).toBe(38);
    expect(result.recordLayouts[0]?.position.left).toBe(38);
    expect(result.recordLayouts[0]?.position.width).toBe(62);
  });

  it('planLaneWidthPercent を変更するとレーン幅も追従する', () => {
    const result = calculateTwoLaneLayout({
      plans: [makePlan()],
      records: [makeRecord()],
      hourHeight: HOUR_HEIGHT,
      planLaneWidthPercent: 50,
    });
    expect(result.planLayouts[0]?.position.width).toBe(50);
    expect(result.recordLayouts[0]?.position.left).toBe(50);
    expect(result.recordLayouts[0]?.position.width).toBe(50);
  });

  it('9:00-10:00 (hourHeight=60) は top=540px, height=60px', () => {
    const result = calculateTwoLaneLayout({
      plans: [makePlan()],
      records: [],
      hourHeight: HOUR_HEIGHT,
    });
    expect(result.planLayouts[0]?.position).toMatchObject({ top: 540, height: 60 });
  });

  it('日をまたぐ場合は当日の終端(24:00)でクランプする', () => {
    const result = calculateTwoLaneLayout({
      plans: [
        makePlan({
          displayStartDate: localDate(23, 0),
          displayEndDate: localDate(2, 0, 11),
        }),
      ],
      records: [],
      hourHeight: HOUR_HEIGHT,
    });
    // 23:00 → top=1380px, 24:00までの1時間 → height=60px
    expect(result.planLayouts[0]?.position).toMatchObject({ top: 1380, height: 60 });
  });

  it('plans/records 複数件をそれぞれ独立に配置する（レーン内は重複しない前提）', () => {
    const result = calculateTwoLaneLayout({
      plans: [
        makePlan({ id: 'p1' }),
        makePlan({
          id: 'p2',
          displayStartDate: localDate(11, 0),
          displayEndDate: localDate(11, 30),
        }),
      ],
      records: [],
      hourHeight: HOUR_HEIGHT,
    });
    expect(result.planLayouts).toHaveLength(2);
    expect(result.planLayouts[1]?.position).toMatchObject({ top: 660, height: 30 });
  });

  it('同一レーンで隣接するイベントは2pxだけ離す', () => {
    const result = calculateTwoLaneLayout({
      plans: [
        makePlan({ id: 'p1' }),
        makePlan({
          id: 'p2',
          displayStartDate: localDate(10, 0),
          displayEndDate: localDate(10, 30),
        }),
      ],
      records: [],
      hourHeight: HOUR_HEIGHT,
    });
    expect(result.planLayouts[1]?.position).toMatchObject({ top: 602, height: 28 });
  });

  it('レコードレーンでも隣接イベント間に2pxの間隔を入れる', () => {
    const result = calculateTwoLaneLayout({
      plans: [],
      records: [
        makeRecord({
          id: 'r1',
          displayStartDate: localDate(9, 0),
          displayEndDate: localDate(10, 0),
        }),
        makeRecord({
          id: 'r2',
          displayStartDate: localDate(10, 0),
          displayEndDate: localDate(11, 0),
        }),
      ],
      hourHeight: HOUR_HEIGHT,
    });
    expect(result.recordLayouts[1]?.position).toMatchObject({ top: 602, height: 58 });
  });

  it('連続する短いイベントでも間隔を累積させず24:00内に収める', () => {
    const plans = Array.from({ length: 96 }, (_, index) => {
      const startMinutes = index * 15;
      const endMinutes = startMinutes + 15;
      return makePlan({
        id: `p${index}`,
        displayStartDate: localDate(Math.floor(startMinutes / 60), startMinutes % 60),
        displayEndDate:
          endMinutes === 24 * 60
            ? localDate(0, 0, 11)
            : localDate(Math.floor(endMinutes / 60), endMinutes % 60),
      });
    });

    const result = calculateTwoLaneLayout({ plans, records: [], hourHeight: HOUR_HEIGHT });
    const lastPosition = result.planLayouts.at(-1)?.position;

    // records が無いため、この plan は相手レーンの counterpart が無くフル幅になる（#2250）。
    expect(lastPosition).toEqual({ top: 1427, height: 13, left: 0, width: 100 });
    expect((lastPosition?.top ?? 0) + (lastPosition?.height ?? 0)).toBe(24 * HOUR_HEIGHT);
  });
});

describe('calculateTwoLaneLayout（#2250: 区間ごとの動的幅判定）', () => {
  it('相手レーンに時間の重なりが無ければ Plan はフル幅（left=0, width=100）になる', () => {
    const result = calculateTwoLaneLayout({
      plans: [makePlan({ displayStartDate: localDate(9, 0), displayEndDate: localDate(10, 0) })],
      records: [
        makeRecord({ displayStartDate: localDate(14, 0), displayEndDate: localDate(15, 0) }),
      ],
      hourHeight: HOUR_HEIGHT,
    });

    expect(result.planLayouts[0]?.position).toMatchObject({ left: 0, width: 100 });
    expect(result.recordLayouts[0]?.position).toMatchObject({ left: 0, width: 100 });
  });

  it('相手レーンと時間が重なる entry だけ split 幅になる（重ならない entry は同じレーン内でもフル幅）', () => {
    const result = calculateTwoLaneLayout({
      plans: [
        makePlan({
          id: 'p-overlap',
          displayStartDate: localDate(9, 0),
          displayEndDate: localDate(10, 0),
        }),
        makePlan({
          id: 'p-alone',
          displayStartDate: localDate(14, 0),
          displayEndDate: localDate(15, 0),
        }),
      ],
      records: [
        makeRecord({
          id: 'r-overlap',
          displayStartDate: localDate(9, 30),
          displayEndDate: localDate(10, 30),
        }),
      ],
      hourHeight: HOUR_HEIGHT,
    });

    const overlapping = result.planLayouts.find((l) => l.entry.id === 'p-overlap');
    const alone = result.planLayouts.find((l) => l.entry.id === 'p-alone');
    expect(overlapping?.position).toMatchObject({ left: 0, width: 38 });
    expect(alone?.position).toMatchObject({ left: 0, width: 100 });
  });

  it('境界が接するだけ（隣接、重複しない）の entry はフル幅になる', () => {
    const result = calculateTwoLaneLayout({
      plans: [makePlan({ displayStartDate: localDate(9, 0), displayEndDate: localDate(10, 0) })],
      records: [
        makeRecord({ displayStartDate: localDate(10, 0), displayEndDate: localDate(11, 0) }),
      ],
      hourHeight: HOUR_HEIGHT,
    });

    expect(result.planLayouts[0]?.position).toMatchObject({ left: 0, width: 100 });
    expect(result.recordLayouts[0]?.position).toMatchObject({ left: 0, width: 100 });
  });

  it('部分的に重なるだけでも split 幅になる', () => {
    const result = calculateTwoLaneLayout({
      plans: [makePlan({ displayStartDate: localDate(9, 0), displayEndDate: localDate(10, 0) })],
      records: [
        makeRecord({ displayStartDate: localDate(9, 55), displayEndDate: localDate(11, 0) }),
      ],
      hourHeight: HOUR_HEIGHT,
    });

    expect(result.planLayouts[0]?.position).toMatchObject({ left: 0, width: 38 });
    expect(result.recordLayouts[0]?.position).toMatchObject({ left: 38, width: 62 });
  });

  it('別アクティビティでも1分だけ重なれば split 幅になる', () => {
    const result = calculateTwoLaneLayout({
      plans: [
        makePlan({
          activityId: 'activity-plan',
          displayStartDate: localDate(9, 0),
          displayEndDate: localDate(10, 0),
        }),
      ],
      records: [
        makeRecord({
          activityId: 'activity-record',
          displayStartDate: localDate(9, 59),
          displayEndDate: localDate(11, 0),
        }),
      ],
      hourHeight: HOUR_HEIGHT,
    });

    expect(result.planLayouts[0]?.position.width).toBe(38);
    expect(result.recordLayouts[0]?.position.width).toBe(62);
  });
});

describe('hasLaneCounterpart', () => {
  it('区間が交差すれば true', () => {
    expect(
      hasLaneCounterpart(
        [{ displayStartDate: localDate(9, 30), displayEndDate: localDate(10, 30) }],
        localDate(9, 0),
        localDate(10, 0),
      ),
    ).toBe(true);
  });

  it('区間が接するだけ（重複しない）なら false', () => {
    expect(
      hasLaneCounterpart(
        [{ displayStartDate: localDate(10, 0), displayEndDate: localDate(11, 0) }],
        localDate(9, 0),
        localDate(10, 0),
      ),
    ).toBe(false);
  });

  it('候補が空なら false', () => {
    expect(hasLaneCounterpart([], localDate(9, 0), localDate(10, 0))).toBe(false);
  });

  it('target 区間が縮退（end<=start）なら安全側の true', () => {
    expect(hasLaneCounterpart([], localDate(9, 0), localDate(9, 0))).toBe(true);
  });
});

describe('resolveTwoLaneFromPointer', () => {
  it('全ビュー共通の既定38%境界より左をPlan、右をRecordにする', () => {
    expect(DEFAULT_PLAN_LANE_WIDTH_PERCENT).toBe(38);
    expect(resolveTwoLaneFromPointer(137, 100, 100)).toBe('plan');
    expect(resolveTwoLaneFromPointer(138, 100, 100)).toBe('record');
  });

  it('既定値に戻した38%幅を反映する', () => {
    expect(resolveTwoLaneFromPointer(137, 100, 100, 38)).toBe('plan');
    expect(resolveTwoLaneFromPointer(138, 100, 100, 38)).toBe('record');
  });

  it('明示した境界幅を反映する', () => {
    expect(resolveTwoLaneFromPointer(149, 100, 100, 50)).toBe('plan');
    expect(resolveTwoLaneFromPointer(150, 100, 100, 50)).toBe('record');
  });

  // #2250 plan-review で検出した P1 故障モード（本 issue のcoreとなるregression test）:
  // 相手レーンの entry が無い時刻（= 画面上フル幅で境界が見えない）では、
  // pointer の x 座標に関わらず sourceLane のまま維持し、意図しない
  // Plan→Record 変換 mutation を発火させない。
  it('相手レーンに counterpart が無い時、x座標に関わらず sourceLane を維持する（不可視 mutation の防止）', () => {
    // x=138（既定38%境界より右、通常なら'record'と判定される位置）でも、
    // hasCounterpart=false なら sourceLane='plan' を返す。
    expect(
      resolveTwoLaneFromPointer(138, 100, 100, 38, { sourceLane: 'plan', hasCounterpart: false }),
    ).toBe('plan');
    // 境界の左端（x=137）でも同様に sourceLane を維持する。
    expect(
      resolveTwoLaneFromPointer(137, 100, 100, 38, { sourceLane: 'plan', hasCounterpart: false }),
    ).toBe('plan');
  });

  it('相手レーンに counterpart がある時は、laneAvailability を渡しても従来どおり x座標で判定する', () => {
    expect(
      resolveTwoLaneFromPointer(138, 100, 100, 38, { sourceLane: 'plan', hasCounterpart: true }),
    ).toBe('record');
    expect(
      resolveTwoLaneFromPointer(137, 100, 100, 38, { sourceLane: 'plan', hasCounterpart: true }),
    ).toBe('plan');
  });
});
