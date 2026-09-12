import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { PRESET_USER_SETTINGS } from '@dayopt/storybook/mocks/presets';

import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

import { DragSelectionPreview } from './CalendarDragSelection/DragSelectionPreview';

/** ドラッグ選択プレビュー。グリッド上の時間範囲選択UI。 */
const meta = {
  title: 'Product/Features/Calendar/Interaction/DragSelectionPreview',
  parameters: {
    layout: 'padded',
    // 残り時間は予定の instant をユーザー TZ の暦日へ落として合計するため、TZ を固定する
    trpcMocks: { 'userSettings.get': PRESET_USER_SETTINGS.default },
  },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function Slot({ children, height = 72 }: { children: React.ReactNode; height?: number }) {
  return (
    <div className="relative w-full" style={{ height }}>
      {children}
    </div>
  );
}

const formatTime = (hour: number, minute: number) => {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/** 2099-01-01（Asia/Tokyo）に置かれた予定。残り時間の合計対象になる */
function planOnNewYear(startHourUtc: number, hours: number): CalendarDisplayEvent {
  const start = new Date(Date.UTC(2099, 0, 1, startHourUtc, 0, 0, 0));
  const end = new Date(Date.UTC(2099, 0, 1, startHourUtc + hours, 0, 0, 0));

  return {
    id: `plan-${startHourUtc}`,
    title: 'Focus',
    startDate: start,
    endDate: end,
    plannedStartDate: start,
    plannedEndDate: end,
    displayStartDate: start,
    displayEndDate: end,
    status: 'open',
    color: 'var(--category-blue)',
    activityId: 'a1',
    createdAt: start,
    updatedAt: end,
    version: '2026-07-15T00:00:00.000000Z',
    duration: hours * 60,
    isMultiDay: false,
    kind: 'plan',
  } as CalendarDisplayEvent;
}

const futureDate = new Date('2099-01-01T00:00:00');
const twoHourSelection = { startHour: 0, startMinute: 0, endHour: 2, endMinute: 0 };

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** 未来時間に作るPlanのプレビュー。 */
export const FuturePlan: Story = {
  render: () => (
    <Slot>
      <DragSelectionPreview
        selection={{ startHour: 0, startMinute: 0, endHour: 1, endMinute: 0 }}
        date={new Date('2099-01-01T00:00:00')}
        formatTime={formatTime}
      />
    </Slot>
  ),
};

/** 過去時間に作るRecordのプレビュー。 */
export const PastRecord: Story = {
  render: () => (
    <Slot>
      <DragSelectionPreview
        selection={{ startHour: 0, startMinute: 0, endHour: 1, endMinute: 0 }}
        date={new Date('2000-01-01T00:00:00')}
        formatTime={formatTime}
      />
    </Slot>
  ),
};

/** 時間重複時のエラー表示。赤背景 + Banアイコン。 */
export const Overlapping: Story = {
  render: () => (
    <Slot>
      <DragSelectionPreview
        selection={{ startHour: 0, startMinute: 0, endHour: 1, endMinute: 0 }}
        date={new Date('2099-01-01T00:00:00')}
        formatTime={formatTime}
        isOverlapping
      />
    </Slot>
  ),
};

/**
 * その日の残り時間（#2096）。予定として保存される選択のときだけ、
 * `24h - その日の予定合計 - 選択中の長さ` を静かに添える。
 */
export const Remaining: Story = {
  render: () => (
    <Slot height={160}>
      <DragSelectionPreview
        selection={twoHourSelection}
        date={futureDate}
        formatTime={formatTime}
        allDayEvents={[planOnNewYear(3, 1), planOnNewYear(6, 2)]}
      />
    </Slot>
  ),
};

/** 24h を超えて置いている日。符号だけで示し、色や警告は付けない。 */
export const RemainingNegative: Story = {
  render: () => (
    <Slot height={160}>
      <DragSelectionPreview
        selection={twoHourSelection}
        date={futureDate}
        formatTime={formatTime}
        allDayEvents={[planOnNewYear(0, 8), planOnNewYear(8, 8), planOnNewYear(16, 7)]}
      />
    </Slot>
  ),
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <Slot>
        <DragSelectionPreview
          selection={{ startHour: 0, startMinute: 0, endHour: 1, endMinute: 0 }}
          date={new Date('2099-01-01T00:00:00')}
          formatTime={formatTime}
        />
      </Slot>
      <Slot>
        <DragSelectionPreview
          selection={{ startHour: 0, startMinute: 0, endHour: 1, endMinute: 0 }}
          date={new Date('2000-01-01T00:00:00')}
          formatTime={formatTime}
        />
      </Slot>
      <Slot>
        <DragSelectionPreview
          selection={{ startHour: 0, startMinute: 0, endHour: 1, endMinute: 0 }}
          date={new Date('2099-01-01T00:00:00')}
          formatTime={formatTime}
          isOverlapping
        />
      </Slot>
      <Slot height={160}>
        <DragSelectionPreview
          selection={twoHourSelection}
          date={futureDate}
          formatTime={formatTime}
          allDayEvents={[planOnNewYear(3, 1), planOnNewYear(6, 2)]}
        />
      </Slot>
      <Slot height={160}>
        <DragSelectionPreview
          selection={twoHourSelection}
          date={futureDate}
          formatTime={formatTime}
          allDayEvents={[planOnNewYear(0, 8), planOnNewYear(8, 8), planOnNewYear(16, 7)]}
        />
      </Slot>
    </div>
  ),
};
