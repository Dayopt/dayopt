import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { RecordEvent } from '@/features/timeblock';

import type { TwoLanePosition } from '../../../../../lib/two-lane-layout';

import { RecordLaneCard } from './RecordLaneCard';

function Slot({ children, height = 90 }: { children: React.ReactNode; height?: number }) {
  return (
    <div
      className="border-border relative w-40 overflow-hidden rounded-lg border"
      style={{ height }}
    >
      {children}
    </div>
  );
}

const basePosition: TwoLanePosition = { top: 8, height: 70, left: 4, width: 92 };

function makeEvent(overrides: Partial<RecordEvent> = {}): RecordEvent {
  const start = new Date(2026, 6, 15, 10, 0);
  const end = new Date(2026, 6, 15, 11, 0);
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

/**
 * Record レーン用カード。塗り(主役)+差分バッジ(±0非表示)+予定外マーカーの全 variant。
 */
const meta = {
  title: 'Product/Features/Calendar/TwoLane/RecordLaneCard',
  component: RecordLaneCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    event: makeEvent(),
    position: basePosition,
    activityName: 'Deep Work',
  },
  argTypes: {
    showDayDiffMarker: { control: 'boolean' },
    interactive: { control: 'boolean' },
  },
} satisfies Meta<typeof RecordLaneCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 独立した記録。予定別の差分バッジは表示しない。 */
export const Recorded: Story = {
  render: () => (
    <Slot>
      <RecordLaneCard
        event={makeEvent({})}
        position={basePosition}
        activityName="Deep Work"
        activityColor="blue"
      />
    </Slot>
  ),
};

/** カテゴリーの色（teal）。 */
export const Teal: Story = {
  render: () => (
    <Slot>
      <RecordLaneCard
        event={makeEvent({})}
        position={basePosition}
        activityName="Deep Work"
        activityColor="teal"
      />
    </Slot>
  ),
};

/** カテゴリーの色（amber）。 */
export const Amber: Story = {
  render: () => (
    <Slot>
      <RecordLaneCard
        event={makeEvent({})}
        position={basePosition}
        activityName="Deep Work"
        activityColor="amber"
      />
    </Slot>
  ),
};

/** 独立した記録。静かなマーカーのみ表示する。 */
export const Unplanned: Story = {
  render: () => (
    <Slot>
      <RecordLaneCard
        event={makeEvent({})}
        position={basePosition}
        activityName="Deep Work"
        activityColor="violet"
      />
    </Slot>
  ),
};

/**
 * タグ未設定（未分類）。title は表示へフォールバックしない。
 * 実際のカレンダーは activityName=null と同時に activityColor/activityIcon も null になるため、
 * ここでも両方 null にして中立表示（背景・アイコンとも中立）を確認する。
 */
export const NoTag: Story = {
  render: () => (
    <Slot>
      <RecordLaneCard event={makeEvent({})} position={basePosition} activityName={null} />
    </Slot>
  ),
};

/** 低い高さ。時間表示を省略する。 */
export const Compact: Story = {
  render: () => (
    <Slot height={40}>
      <RecordLaneCard
        event={makeEvent({})}
        position={{ ...basePosition, height: 24 }}
        activityName="Deep Work"
        activityColor="red"
      />
    </Slot>
  ),
};

/** Compare panel に表示中の予定外Record。 */
export const CompareTarget: Story = {
  render: () => (
    <Slot>
      <RecordLaneCard
        event={makeEvent({})}
        position={basePosition}
        activityName="Deep Work"
        activityColor="violet"
        showDayDiffMarker
      />
    </Slot>
  ),
};

/** Drag中の表示専用preview。操作・focus対象にしない。 */
export const GhostPreview: Story = {
  render: () => (
    <Slot>
      <RecordLaneCard
        event={makeEvent({})}
        position={basePosition}
        activityName="Deep Work"
        activityColor="blue"
        interactive={false}
        className="shadow-card"
      />
    </Slot>
  ),
};

/** Week / 5-day の狭い Record レーン。secondary detail は省略する。 */
export const NarrowLane: Story = {
  render: () => (
    <div className="border-border relative h-24 w-16 overflow-hidden rounded-lg border">
      <RecordLaneCard
        event={makeEvent({ title: 'デザインレビュー' })}
        position={{ ...basePosition, left: 0, width: 100 }}
        activityName="Deep Work"
        activityColor="teal"
        compact
      />
    </div>
  ),
};

export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-4">
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">差分なし</p>
        <Slot>
          <RecordLaneCard
            event={makeEvent({})}
            position={basePosition}
            activityName="Deep Work"
            activityColor="blue"
          />
        </Slot>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">超過(+20min)</p>
        <Slot>
          <RecordLaneCard
            event={makeEvent({})}
            position={basePosition}
            activityName="Deep Work"
            activityColor="teal"
          />
        </Slot>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">前倒し(-15min)</p>
        <Slot>
          <RecordLaneCard
            event={makeEvent({})}
            position={basePosition}
            activityName="Deep Work"
            activityColor="amber"
          />
        </Slot>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">予定外</p>
        <Slot>
          <RecordLaneCard
            event={makeEvent({})}
            position={basePosition}
            activityName="Deep Work"
            activityColor="violet"
            showDayDiffMarker
          />
        </Slot>
      </div>
      <Slot>
        <RecordLaneCard
          event={makeEvent({})}
          position={basePosition}
          activityName="Deep Work"
          activityColor="blue"
          interactive={false}
          className="shadow-card"
        />
      </Slot>
      <div className="border-border relative h-24 w-16 overflow-hidden rounded-lg border">
        <RecordLaneCard
          event={makeEvent({ title: 'デザインレビュー' })}
          position={{ ...basePosition, left: 0, width: 100 }}
          activityName="Deep Work"
          activityColor="teal"
          compact
        />
      </div>
    </div>
  ),
};
