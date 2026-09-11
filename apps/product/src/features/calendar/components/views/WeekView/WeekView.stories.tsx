import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import type { CalendarDisplayEvent, ViewDateRange } from '../../../types/calendar.types';

import { WeekView } from './WeekView';

/** WeekView - 週表示ビュー */
const meta = {
  title: 'Product/Features/Calendar/Views/WeekView',
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Mock Data
// ─────────────────────────────────────────────────────────

const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

// 期限切れエントリのベース日（先週）
const lastWeek = new Date(today);
lastWeek.setDate(today.getDate() - 7);

// 月曜始まりの週を計算
const dayOfWeek = today.getDay();
const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
const weekStart = new Date(today.getTime() + mondayOffset * 24 * 60 * 60 * 1000);
const weekDays = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(weekStart);
  d.setDate(weekStart.getDate() + i);
  return d;
});
const weekEnd = weekDays[6] ?? today;

// 日曜始まりの週を計算（weekStartsOn=0 用）
const sundayOffset = dayOfWeek === 0 ? 0 : -dayOfWeek;
const sundayWeekStart = new Date(today.getTime() + sundayOffset * 24 * 60 * 60 * 1000);
const sundayWeekDays = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(sundayWeekStart);
  d.setDate(sundayWeekStart.getDate() + i);
  return d;
});
const sundayWeekEnd = sundayWeekDays[6] ?? today;

// 土曜始まりの週を計算（weekStartsOn=6 用）
const saturdayOffset = dayOfWeek === 6 ? 0 : dayOfWeek === 0 ? -1 : -(dayOfWeek + 1);
const saturdayWeekStart = new Date(today.getTime() + saturdayOffset * 24 * 60 * 60 * 1000);
const saturdayWeekDays = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(saturdayWeekStart);
  d.setDate(saturdayWeekStart.getDate() + i);
  return d;
});
const saturdayWeekEnd = saturdayWeekDays[6] ?? today;

function makeDate(base: Date, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const basePlan: CalendarDisplayEvent = {
  id: 'plan-1',
  title: 'チームミーティング',
  startDate: makeDate(today, 10, 0),
  endDate: makeDate(today, 11, 0),
  status: 'open',
  color: 'var(--primary)',
  createdAt: now,
  updatedAt: now,
  version: '2026-07-15T00:00:00.000000Z',
  displayStartDate: makeDate(today, 10, 0),
  displayEndDate: makeDate(today, 11, 0),
  duration: 60,
  isMultiDay: false,

  kind: 'plan',
};

// 週の各日に分散したプラン
const mockPlans: CalendarDisplayEvent[] = [
  // 月曜
  {
    ...basePlan,
    id: 'plan-1',
    title: '朝会',
    startDate: makeDate(weekDays[0] ?? weekStart, 9, 0),
    endDate: makeDate(weekDays[0] ?? weekStart, 9, 30),
    displayStartDate: makeDate(weekDays[0] ?? weekStart, 9, 0),
    displayEndDate: makeDate(weekDays[0] ?? weekStart, 9, 30),
    duration: 30,
  },
  // 火曜
  {
    ...basePlan,
    id: 'plan-2',
    title: 'デザインレビュー',
    color: 'amber',
    startDate: makeDate(weekDays[1] ?? weekStart, 14, 0),
    endDate: makeDate(weekDays[1] ?? weekStart, 15, 30),
    displayStartDate: makeDate(weekDays[1] ?? weekStart, 14, 0),
    displayEndDate: makeDate(weekDays[1] ?? weekStart, 15, 30),
    duration: 90,
  },
  // 水曜
  {
    ...basePlan,
    id: 'plan-3',
    title: 'ランチミーティング',
    color: 'green',
    startDate: makeDate(weekDays[2] ?? weekStart, 12, 0),
    endDate: makeDate(weekDays[2] ?? weekStart, 13, 0),
    displayStartDate: makeDate(weekDays[2] ?? weekStart, 12, 0),
    displayEndDate: makeDate(weekDays[2] ?? weekStart, 13, 0),
  },
  // 木曜
  {
    ...basePlan,
    id: 'plan-4',
    title: 'コーディング',
    color: 'violet',
    startDate: makeDate(weekDays[3] ?? weekStart, 10, 0),
    endDate: makeDate(weekDays[3] ?? weekStart, 12, 0),
    displayStartDate: makeDate(weekDays[3] ?? weekStart, 10, 0),
    displayEndDate: makeDate(weekDays[3] ?? weekStart, 12, 0),
    duration: 120,
  },
  // 金曜
  {
    ...basePlan,
    id: 'plan-5',
    title: '振り返り',
    color: 'red',
    startDate: makeDate(weekDays[4] ?? weekStart, 16, 0),
    endDate: makeDate(weekDays[4] ?? weekStart, 17, 0),
    displayStartDate: makeDate(weekDays[4] ?? weekStart, 16, 0),
    displayEndDate: makeDate(weekDays[4] ?? weekStart, 17, 0),
  },
];

/** 期限切れ未完了エントリ（先週のタスク）*/
const overdueEntry: CalendarDisplayEvent = {
  ...basePlan,
  id: 'overdue-1',
  title: '期限切れタスク（先週）',
  color: 'red',
  startDate: makeDate(lastWeek, 14, 0),
  endDate: makeDate(lastWeek, 15, 0),
  displayStartDate: makeDate(lastWeek, 14, 0),
  displayEndDate: makeDate(lastWeek, 15, 0),
  status: 'open',
};

const weekRange: ViewDateRange = {
  start: weekStart,
  end: weekEnd,
  days: weekDays,
};

const sundayWeekRange: ViewDateRange = {
  start: sundayWeekStart,
  end: sundayWeekEnd,
  days: sundayWeekDays,
};

const saturdayWeekRange: ViewDateRange = {
  start: saturdayWeekStart,
  end: saturdayWeekEnd,
  days: saturdayWeekDays,
};

// ─────────────────────────────────────────────────────────
// Default handler args (共通)
// ─────────────────────────────────────────────────────────

const defaultHandlers = {
  onEntryClick: fn(),
  onEntryContextMenu: fn(),
  onUpdateEntry: fn(),
  onDeleteTimeblock: fn(),
  onTimeRangeSelect: fn(),
  onViewChange: fn(),
  onNavigatePrev: fn(),
  onNavigateNext: fn(),
  onNavigateToday: fn(),
};

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** デフォルト（プランあり） */
export const Default: Story = {
  render: () => (
    <div className="h-[700px]">
      <WeekView
        dateRange={weekRange}
        entries={mockPlans}
        currentDate={today}
        {...defaultHandlers}
      />
    </div>
  ),
};

/** inline right rail と共存できる最小 Calendar 幅。 */
export const MinimumInlineWidth: Story = {
  render: () => (
    <div className="h-[700px] w-full max-w-3xl">
      <WeekView
        dateRange={weekRange}
        entries={mockPlans}
        currentDate={today}
        {...defaultHandlers}
      />
    </div>
  ),
};

/** 空（プランなし） */
export const Empty: Story = {
  render: () => (
    <div className="h-[700px]">
      <WeekView dateRange={weekRange} entries={[]} currentDate={today} {...defaultHandlers} />
    </div>
  ),
};

/** 土日非表示 */
export const WithoutWeekends: Story = {
  render: () => (
    <div className="h-[700px]">
      <WeekView
        dateRange={weekRange}
        entries={mockPlans}
        currentDate={today}
        showWeekends={false}
        {...defaultHandlers}
      />
    </div>
  ),
};

/**
 * 全ハンドラー接続済み
 * ドラッグ＆ドロップ・時間範囲選択・右クリックメニューが有効
 */
export const WithAllHandlers: Story = {
  render: () => (
    <div className="h-[700px]">
      <WeekView
        dateRange={weekRange}
        entries={mockPlans}
        allTimeblocks={[...mockPlans, overdueEntry]}
        currentDate={today}
        {...defaultHandlers}
      />
    </div>
  ),
};

/**
 * 月曜始まり（weekStartsOn=1）
 * 設定ストアを上書きして月曜始まりを強制
 */
export const MondayStart: Story = {
  render: () => (
    <div className="h-[700px]">
      <WeekView
        dateRange={weekRange}
        entries={mockPlans}
        currentDate={today}
        weekStartsOn={1}
        {...defaultHandlers}
      />
    </div>
  ),
};

/**
 * 土曜始まり（weekStartsOn=6）
 * 中東・一部アジア地域の週始まり設定
 */
export const SaturdayStart: Story = {
  render: () => (
    <div className="h-[700px]">
      <WeekView
        dateRange={saturdayWeekRange}
        entries={mockPlans}
        currentDate={today}
        weekStartsOn={6}
        {...defaultHandlers}
      />
    </div>
  ),
};

/**
 * 日曜始まり（weekStartsOn=0）
 * 北米・一部アジア地域の週始まり設定
 */
export const SundayStart: Story = {
  render: () => (
    <div className="h-[700px]">
      <WeekView
        dateRange={sundayWeekRange}
        entries={mockPlans}
        currentDate={today}
        weekStartsOn={0}
        {...defaultHandlers}
      />
    </div>
  ),
};

/**
 * 期限切れエントリあり
 * allTimeblocks に先週の未完了タスクを含めることで期限切れ表示を確認できる
 */
export const WithOverdueEntry: Story = {
  render: () => (
    <div className="h-[700px]">
      <WeekView
        dateRange={weekRange}
        entries={mockPlans}
        allTimeblocks={[...mockPlans, overdueEntry]}
        currentDate={today}
        {...defaultHandlers}
      />
    </div>
  ),
};

/** 全パターン一覧 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <div className="h-[500px] w-full">
        <WeekView
          dateRange={weekRange}
          entries={mockPlans}
          allTimeblocks={[...mockPlans, overdueEntry]}
          currentDate={today}
          {...defaultHandlers}
        />
      </div>

      <div className="h-[500px] w-full max-w-3xl">
        <WeekView
          dateRange={weekRange}
          entries={mockPlans}
          currentDate={today}
          {...defaultHandlers}
        />
      </div>

      <div className="h-[500px] w-full">
        <WeekView dateRange={weekRange} entries={[]} currentDate={today} {...defaultHandlers} />
      </div>

      <div className="h-[500px] w-full">
        <WeekView
          dateRange={weekRange}
          entries={mockPlans}
          currentDate={today}
          showWeekends={false}
          {...defaultHandlers}
        />
      </div>

      <div className="h-[500px] w-full">
        <WeekView
          dateRange={weekRange}
          entries={mockPlans}
          currentDate={today}
          weekStartsOn={1}
          {...defaultHandlers}
        />
      </div>

      <div className="h-[500px] w-full">
        <WeekView
          dateRange={saturdayWeekRange}
          entries={mockPlans}
          currentDate={today}
          weekStartsOn={6}
          {...defaultHandlers}
        />
      </div>
    </div>
  ),
};
