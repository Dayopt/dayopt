import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { PlanEvent, RecordEvent } from '@/features/timeblock';

import { TwoLaneDayColumn } from './TwoLaneDayColumn';

/**
 * 1日分の Plan レーン + Record レーン合成。Record が主役(塗り)、Plan は控えめ(アウトライン)。
 * useTagsMap はグローバルプロバイダーで解決済み。
 */
const meta = {
  title: 'Product/Features/Calendar/TwoLane/TwoLaneDayColumn',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="border-border relative w-64 overflow-hidden rounded-lg border"
      style={{ height: 500 }}
    >
      {children}
    </div>
  );
}

function makeDate(hour: number, minute = 0): Date {
  return new Date(2026, 6, 15, hour, minute);
}

function makePlan(overrides: Partial<PlanEvent> = {}): PlanEvent {
  return {
    id: 'plan-1',
    title: 'Deep Work',
    note: null,
    activityId: null,
    startDate: makeDate(9, 0),
    endDate: makeDate(10, 0),
    displayStartDate: makeDate(9, 0),
    displayEndDate: makeDate(10, 0),
    duration: 60,
    status: 'upcoming',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<RecordEvent> = {}): RecordEvent {
  return {
    id: 'record-1',
    title: 'Deep Work',
    note: null,
    activityId: null,
    startDate: makeDate(9, 0),
    endDate: makeDate(9, 45),
    displayStartDate: makeDate(9, 0),
    displayEndDate: makeDate(9, 45),
    duration: 45,
    ...overrides,
  };
}

/** 予定+記録が揃っている日（差分あり）。 */
export const WithPlanAndRecord: Story = {
  render: () => (
    <Frame>
      <TwoLaneDayColumn hourHeight={72} plans={[makePlan()]} records={[makeRecord({})]} />
    </Frame>
  ),
};

/** 未記録の過去 Plan + 予定外の記録が混在する日。 */
export const MixedDay: Story = {
  render: () => (
    <Frame>
      <TwoLaneDayColumn
        hourHeight={72}
        plans={[
          makePlan({ id: 'p1', status: 'unrecorded' }),
          makePlan({
            id: 'p2',
            title: 'Standup',
            startDate: makeDate(11, 0),
            endDate: makeDate(11, 30),
            displayStartDate: makeDate(11, 0),
            displayEndDate: makeDate(11, 30),
            duration: 30,
            status: 'unrecorded',
          }),
        ]}
        records={[makeRecord({ id: 'l1', title: 'メール返信' })]}
      />
    </Frame>
  ),
};

/** 空の日。 */
export const Empty: Story = {
  render: () => (
    <Frame>
      <TwoLaneDayColumn hourHeight={72} plans={[]} records={[]} />
    </Frame>
  ),
};

export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-6">
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">予定+記録（差分あり）</p>
        <Frame>
          <TwoLaneDayColumn hourHeight={72} plans={[makePlan()]} records={[makeRecord({})]} />
        </Frame>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">未記録の予定と記録が混在</p>
        <Frame>
          <TwoLaneDayColumn
            hourHeight={72}
            plans={[
              makePlan({ id: 'p1', status: 'unrecorded' }),
              makePlan({
                id: 'p2',
                title: 'Standup',
                startDate: makeDate(11, 0),
                endDate: makeDate(11, 30),
                displayStartDate: makeDate(11, 0),
                displayEndDate: makeDate(11, 30),
                duration: 30,
                status: 'unrecorded',
              }),
            ]}
            records={[makeRecord({ id: 'l1', title: 'メール返信' })]}
          />
        </Frame>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">空</p>
        <Frame>
          <TwoLaneDayColumn hourHeight={72} plans={[]} records={[]} />
        </Frame>
      </div>
    </div>
  ),
};
