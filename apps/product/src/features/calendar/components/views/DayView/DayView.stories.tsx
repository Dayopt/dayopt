import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import { PRESET_USER_SETTINGS } from '@dayopt/storybook/mocks/presets';
import { StoryTRPCProvider } from '@dayopt/storybook/mocks/trpc';
import { computeCalendarDayDiffs } from '../../../lib/day-diff';
import type { CalendarDisplayEvent, ViewDateRange } from '../../../types/calendar.types';

import { DayView } from './DayView';

/** DayView - 日表示ビュー */
const meta = {
  title: 'Product/Features/Calendar/Views/DayView',
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

// 期限切れエントリのベース日（昨日）
const yesterday = new Date(today);
yesterday.setDate(today.getDate() - 1);

function makeDate(base: Date, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const basePlan: CalendarDisplayEvent = {
  id: 'plan-1',
  title: 'チームミーティング',
  description: '週次の進捗確認',
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

const mockPlans: CalendarDisplayEvent[] = [
  basePlan,
  {
    ...basePlan,
    id: 'plan-2',
    title: 'ランチ',
    color: 'green',
    startDate: makeDate(today, 12, 0),
    endDate: makeDate(today, 13, 0),
    displayStartDate: makeDate(today, 12, 0),
    displayEndDate: makeDate(today, 13, 0),
  },
  {
    ...basePlan,
    id: 'plan-3',
    title: 'デザインレビュー',
    color: 'amber',
    startDate: makeDate(today, 14, 0),
    endDate: makeDate(today, 15, 30),
    displayStartDate: makeDate(today, 14, 0),
    displayEndDate: makeDate(today, 15, 30),
    duration: 90,
  },
  {
    ...basePlan,
    id: 'plan-4',
    title: 'コーディング',
    color: 'violet',
    startDate: makeDate(today, 16, 0),
    endDate: makeDate(today, 18, 0),
    displayStartDate: makeDate(today, 16, 0),
    displayEndDate: makeDate(today, 18, 0),
    duration: 120,
  },
];

/** 期限切れ未完了エントリ（昨日のタスク）*/
const overdueEntry: CalendarDisplayEvent = {
  ...basePlan,
  id: 'overdue-1',
  title: '期限切れタスク（昨日）',
  color: 'red',
  startDate: makeDate(yesterday, 14, 0),
  endDate: makeDate(yesterday, 15, 0),
  displayStartDate: makeDate(yesterday, 14, 0),
  displayEndDate: makeDate(yesterday, 15, 0),
  status: 'open',
};

const todayRange: ViewDateRange = {
  start: today,
  end: today,
  days: [today],
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

const TWELVE_HOUR_SETTINGS = {
  ...PRESET_USER_SETTINGS.default,
  timeFormat: '12h' as const,
};

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** デフォルト（プランあり） */
export const Default: Story = {
  render: () => (
    <div className="h-[700px]">
      <DayView
        dateRange={todayRange}
        entries={mockPlans}
        currentDate={today}
        {...defaultHandlers}
      />
    </div>
  ),
};

/** ユーザー設定を反映した12時間表記。 */
export const TwelveHour: Story = {
  parameters: {
    trpcMocks: { 'userSettings.get': TWELVE_HOUR_SETTINGS },
  },
  render: () => (
    <div className="h-[700px]">
      <DayView
        dateRange={todayRange}
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
      <DayView dateRange={todayRange} entries={[]} currentDate={today} {...defaultHandlers} />
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
      <DayView
        dateRange={todayRange}
        entries={mockPlans}
        allTimeblocks={[...mockPlans, overdueEntry]}
        currentDate={today}
        {...defaultHandlers}
      />
    </div>
  ),
};

/**
 * 期限切れエントリあり
 * allTimeblocks に昨日の未完了タスクを含めることで期限切れ表示を確認できる
 */
export const WithOverdueEntry: Story = {
  render: () => (
    <div className="h-[700px]">
      <DayView
        dateRange={todayRange}
        entries={mockPlans}
        allTimeblocks={[...mockPlans, overdueEntry]}
        currentDate={today}
        {...defaultHandlers}
      />
    </div>
  ),
};

// ─────────────────────────────────────────────────────────
// Preset Sample Day — オンボーディング後の初回表示イメージ
// ─────────────────────────────────────────────────────────

const presetBase: CalendarDisplayEvent = {
  id: '',
  title: '',
  status: 'open',
  color: '',
  createdAt: now,
  updatedAt: now,
  version: '2026-07-15T00:00:00.000000Z',
  startDate: null,
  endDate: null,
  displayStartDate: today,
  displayEndDate: today,
  duration: 0,
  isMultiDay: false,
  kind: 'plan',
};

function preset(
  id: string,
  title: string,
  color: string,
  startHour: number,
  startMin: number,
  durationMin: number,
  extra?: Partial<CalendarDisplayEvent>,
): CalendarDisplayEvent {
  const start = makeDate(today, startHour, startMin);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + durationMin);
  return {
    ...presetBase,
    id,
    title,
    color,
    startDate: start,
    endDate: end,
    displayStartDate: start,
    displayEndDate: end,
    duration: durationMin,
    ...extra,
  };
}

/** 過去エントリ（記録済み）の共通props */
const closed: Partial<CalendarDisplayEvent> = { status: 'closed', timeblockState: 'past' };

const presetSampleEntries: CalendarDisplayEvent[] = [
  // 過去（記録済み）
  preset('preset-1', 'Morning Run', 'var(--category-teal)', 8, 0, 30, {
    ...closed,
    // 予定通り実行
    actualStartDate: makeDate(today, 8, 0),
    actualEndDate: makeDate(today, 8, 30),
  }),
  preset('preset-2', 'Draft Proposal', 'var(--category-blue)', 10, 0, 90, {
    ...closed,
    // 10分遅れて開始 → 上部に斜線
    actualStartDate: makeDate(today, 10, 10),
    actualEndDate: makeDate(today, 11, 30),
  }),
  preset('preset-3', 'English Lesson', 'var(--category-green)', 11, 45, 45, {
    ...closed,
    description: 'Unit 5 — Pronunciation practice',
    // 予定通り
    actualStartDate: makeDate(today, 11, 45),
    actualEndDate: makeDate(today, 12, 30),
  }),
  preset('preset-4', 'Lunch & Walk', 'var(--category-amber)', 13, 0, 45, {
    ...closed,
    // 15分早く終了 → 下部に斜線
    actualStartDate: makeDate(today, 13, 0),
    actualEndDate: makeDate(today, 13, 30),
  }),
  // 未来（予定）
  preset('preset-5', 'Prepare Presentation', 'var(--category-blue)', 14, 30, 60, {}),
  preset('preset-6', 'Reading', 'var(--category-violet)', 16, 0, 30, {}),
  preset('preset-7', 'Yoga', 'var(--category-teal)', 18, 0, 45, {}),
];

const presetDiffEntryIds = computeCalendarDayDiffs(
  presetSampleEntries,
  makeDate(today, 23, 0),
).timeblockIds;

/** プリセットサンプルデイ — オンボーディング後の初回表示イメージ */
export const PresetSampleDay: Story = {
  render: () => (
    <div className="h-[700px]">
      <DayView
        dateRange={todayRange}
        entries={presetSampleEntries}
        currentDate={today}
        {...defaultHandlers}
      />
    </div>
  ),
};

/** 比較表示 — Diff Rail の対象 marker を表示 */
export const CompareMode: Story = {
  render: () => (
    <div className="h-[700px]">
      <DayView
        dateRange={todayRange}
        entries={presetSampleEntries}
        currentDate={today}
        showActualDiff
        dayDiffEntryIds={presetDiffEntryIds}
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
        <DayView
          dateRange={todayRange}
          entries={mockPlans}
          allTimeblocks={[...mockPlans, overdueEntry]}
          currentDate={today}
          {...defaultHandlers}
        />
      </div>

      <div className="h-[500px] w-full">
        <DayView dateRange={todayRange} entries={[]} currentDate={today} {...defaultHandlers} />
      </div>

      <div className="h-[500px] w-full">
        <DayView
          dateRange={todayRange}
          entries={presetSampleEntries}
          currentDate={today}
          showActualDiff
          dayDiffEntryIds={presetDiffEntryIds}
          {...defaultHandlers}
        />
      </div>
      <StoryTRPCProvider mocks={{ 'userSettings.get': TWELVE_HOUR_SETTINGS }}>
        <div className="h-[500px] w-full">
          <DayView
            dateRange={todayRange}
            entries={mockPlans}
            currentDate={today}
            {...defaultHandlers}
          />
        </div>
      </StoryTRPCProvider>
    </div>
  ),
};
