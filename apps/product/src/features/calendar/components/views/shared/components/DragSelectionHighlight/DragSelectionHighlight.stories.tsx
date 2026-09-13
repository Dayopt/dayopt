/**
 * DragSelectionHighlight Stories
 *
 * ドラッグ確定後にグリッド上へ残る選択カード。アクティビティを選ぶまでここに出続け、
 * 作成パネルでホバー中のアクティビティの色と名前を先出しする。
 *
 * 予定として保存される選択では、その日の残り時間（#2096）も添える。
 */

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { useTimeblockInspectorStore } from '@/features/timeblock';
import { PRESET_USER_SETTINGS } from '@dayopt/storybook/mocks/presets';

import { useInlineCreateStore } from '../../../../../stores/useInlineCreateStore';
import type { CalendarDisplayEvent } from '../../../../../types/calendar.types';

import { DragSelectionHighlight } from './DragSelectionHighlight';

const HOUR_HEIGHT = 72;

/** 対象日の 0:00 から指定分数を選択済みにする（カードが器の上端に来るよう 0 時起点にする） */
function seedSelection(dayOffset: number, durationMinutes: number, kind?: 'plan' | 'record') {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(0, 0, 0, 0);

  useTimeblockInspectorStore.setState({ createMode: true });
  useInlineCreateStore.setState({
    hoveredActivity: null,
    pendingSelection: {
      date,
      startHour: 0,
      startMinute: 0,
      endHour: Math.floor(durationMinutes / 60),
      endMinute: durationMinutes % 60,
      ...(kind ? { kind } : {}),
    },
  });

  return date;
}

/** 選択と同じ暦日（Asia/Tokyo）に置かれた予定。残り時間の合計対象になる */
function planOnDay(day: Date, startHourJst: number, hours: number): CalendarDisplayEvent {
  // JST = UTC+9。壁時計の暦日をそのまま JST の時刻として instant へ写す
  const start = new Date(
    Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), startHourJst - 9, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), startHourJst - 9 + hours, 0, 0, 0),
  );

  return {
    id: `plan-${startHourJst}`,
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

const meta = {
  title: 'Product/Features/Calendar/Interaction/DragSelectionHighlight',
  parameters: {
    layout: 'padded',
    // 残り時間は予定の instant をユーザー TZ の暦日へ落として合計するため、TZ を固定する
    trpcMocks: {
      'userSettings.get': PRESET_USER_SETTINGS.default,
      'plans.list': [],
      'records.list': [],
    },
  },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** グリッド 1 カラム相当の器。ハイライトは 0 時起点の absolute で置かれる */
function Slot({ children, hours = 2 }: { children: React.ReactNode; hours?: number }) {
  return (
    <div className="relative w-64" style={{ height: hours * HOUR_HEIGHT }}>
      {children}
    </div>
  );
}

/** 未来スロットの選択。予定として保存されるので残り時間を添える。 */
export const PlanWithRemaining: Story = {
  render: () => {
    const day = seedSelection(2, 120);
    return (
      <Slot>
        <DragSelectionHighlight
          hourHeight={HOUR_HEIGHT}
          dayEntries={[planOnDay(day, 13, 1), planOnDay(day, 15, 2)]}
        />
      </Slot>
    );
  },
};

/** 24h を超えて置いている日。符号だけで示し、色や警告は付けない。 */
export const RemainingNegative: Story = {
  render: () => {
    const day = seedSelection(2, 120);
    return (
      <Slot>
        <DragSelectionHighlight
          hourHeight={HOUR_HEIGHT}
          dayEntries={[planOnDay(day, 0, 8), planOnDay(day, 8, 8), planOnDay(day, 16, 7)]}
        />
      </Slot>
    );
  },
};

/** アクティビティをホバー中。色と名前を先出しする。 */
export const HoveredActivity: Story = {
  render: () => {
    const day = seedSelection(2, 120);
    useInlineCreateStore.setState({
      hoveredActivity: { id: 'a1', name: '開発', color: 'blue', icon: 'briefcase' },
    });
    return (
      <Slot>
        <DragSelectionHighlight hourHeight={HOUR_HEIGHT} dayEntries={[planOnDay(day, 13, 1)]} />
      </Slot>
    );
  },
};

/** 過去スロットの選択。記録として保存されるので残り時間は出さない。 */
export const RecordSelection: Story = {
  render: () => {
    seedSelection(-2, 120, 'record');
    return (
      <Slot>
        <DragSelectionHighlight hourHeight={HOUR_HEIGHT} dayEntries={[]} />
      </Slot>
    );
  },
};

/** 30 分の選択。カードが狭いので時刻だけにし、残り時間は出さない。 */
export const Compact: Story = {
  render: () => {
    seedSelection(2, 30);
    return (
      <Slot hours={1}>
        <DragSelectionHighlight hourHeight={HOUR_HEIGHT} dayEntries={[]} />
      </Slot>
    );
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => {
    const day = seedSelection(2, 120);
    return (
      <div className="flex items-start gap-6">
        <Slot>
          <DragSelectionHighlight
            hourHeight={HOUR_HEIGHT}
            dayEntries={[planOnDay(day, 13, 1), planOnDay(day, 15, 2)]}
          />
        </Slot>
        <Slot>
          <DragSelectionHighlight
            hourHeight={HOUR_HEIGHT}
            dayEntries={[planOnDay(day, 0, 8), planOnDay(day, 8, 8), planOnDay(day, 16, 7)]}
          />
        </Slot>
      </div>
    );
  },
};
