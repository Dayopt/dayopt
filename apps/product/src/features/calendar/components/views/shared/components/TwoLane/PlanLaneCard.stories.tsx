import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { PlanEvent, PlanEventStatus } from '@/features/timeblock';

import type { TwoLanePosition } from '../../../../../lib/two-lane-layout';

import { PlanLaneCard } from './PlanLaneCard';

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

function makeEvent(status: PlanEventStatus, overrides: Partial<PlanEvent> = {}): PlanEvent {
  const start = new Date(2026, 6, 15, 10, 0);
  const end = new Date(2026, 6, 15, 11, 0);
  return {
    id: `plan-${status}`,
    title: 'Deep Work',
    note: null,
    activityId: null,
    startDate: start,
    endDate: end,
    displayStartDate: start,
    displayEndDate: end,
    duration: 60,
    status,
    ...overrides,
  };
}

/** Plan レーン用カード。overview.md §4「過去 Plan の見え方」の全 status variant。 */
const meta = {
  title: 'Product/Features/Calendar/TwoLane/PlanLaneCard',
  component: PlanLaneCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    event: makeEvent('upcoming'),
    position: basePosition,
    activityName: 'Deep Work',
  },
  argTypes: {
    showDayDiffMarker: { control: 'boolean' },
    interactive: { control: 'boolean' },
  },
} satisfies Meta<typeof PlanLaneCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Upcoming: Story = {
  render: () => (
    <Slot>
      <PlanLaneCard
        event={makeEvent('upcoming')}
        position={basePosition}
        activityName="Deep Work"
        activityColor="blue"
      />
    </Slot>
  ),
};

export const Active: Story = {
  render: () => (
    <Slot>
      <PlanLaneCard
        event={makeEvent('active')}
        position={basePosition}
        activityName="Deep Work"
        activityColor="teal"
      />
    </Slot>
  ),
};

/** 過去・未記録・未skip。静かなプロンプト(破線)で示す。 */
export const Unrecorded: Story = {
  render: () => (
    <Slot>
      <PlanLaneCard
        event={makeEvent('unrecorded')}
        position={basePosition}
        activityName="Deep Work"
        activityColor="amber"
      />
    </Slot>
  ),
};

/** 同じ時間帯の記録あり。予定全体の完遂は意味しない。 */
export const WithRecords: Story = {
  render: () => (
    <Slot>
      <PlanLaneCard
        event={makeEvent('with-records')}
        position={basePosition}
        activityName="Deep Work"
        activityColor="indigo"
      />
    </Slot>
  ),
};

/**
 * タグ未設定（未分類）。title は表示へフォールバックしない。
 * 実際のカレンダーは activityName=null と同時に activityColor/activityIcon も null になるため、
 * ここでも両方 null にして中立表示（枠線・アイコンとも中立）を確認する。
 */
export const NoTag: Story = {
  render: () => (
    <Slot>
      <PlanLaneCard event={makeEvent('upcoming')} position={basePosition} activityName={null} />
    </Slot>
  ),
};

/** 低い高さ(20px相当)。時間表示を省略する。 */
export const Compact: Story = {
  render: () => (
    <Slot height={40}>
      <PlanLaneCard
        event={makeEvent('upcoming')}
        position={{ ...basePosition, height: 24 }}
        activityName="Deep Work"
        activityColor="red"
      />
    </Slot>
  ),
};

/** Compare panel に表示中のPlan。 */
export const CompareTarget: Story = {
  render: () => (
    <Slot>
      <PlanLaneCard
        event={makeEvent('with-records')}
        position={basePosition}
        activityName="Deep Work"
        activityColor="indigo"
        showDayDiffMarker
      />
    </Slot>
  ),
};

/** Drag中の表示専用preview。操作・focus対象にしない。 */
export const GhostPreview: Story = {
  render: () => (
    <Slot>
      <PlanLaneCard
        event={makeEvent('upcoming')}
        position={basePosition}
        activityName="Deep Work"
        activityColor="blue"
        interactive={false}
        className="shadow-card"
      />
    </Slot>
  ),
};

/** Week / multi-day の狭い Plan レーン。 */
export const NarrowLane: Story = {
  render: () => (
    <div className="border-border relative h-24 w-12 overflow-hidden rounded-lg border">
      <PlanLaneCard
        event={makeEvent('upcoming', { title: 'デザインレビュー' })}
        position={{ ...basePosition, left: 0, width: 100 }}
        activityName="Deep Work"
        activityColor="blue"
        compact
      />
    </div>
  ),
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-4">
      {(
        [
          ['upcoming', 'blue'],
          ['active', 'teal'],
          ['unrecorded', 'amber'],
          ['with-records', 'indigo'],
        ] as const
      ).map(([status, color]) => (
        <Slot key={status}>
          <PlanLaneCard
            event={makeEvent(status)}
            position={basePosition}
            activityName="Deep Work"
            activityColor={color}
            showDayDiffMarker={status === 'with-records'}
          />
        </Slot>
      ))}
      <Slot>
        <PlanLaneCard
          event={makeEvent('upcoming')}
          position={basePosition}
          activityName="Deep Work"
          activityColor="blue"
          interactive={false}
          className="shadow-card"
        />
      </Slot>
      <div className="border-border relative h-24 w-12 overflow-hidden rounded-lg border">
        <PlanLaneCard
          event={makeEvent('upcoming', { title: 'デザインレビュー' })}
          position={{ ...basePosition, left: 0, width: 100 }}
          activityName="Deep Work"
          activityColor="blue"
          compact
        />
      </div>
    </div>
  ),
};
