import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';

import { RecordFulfillmentRow } from '../inspector/fields';
import { EstimationFeedforward } from './EstimationFeedforward';
import { TimeblockEditor, type TimeModelEditorValue } from './TimeblockEditor';

import type { Fulfillment } from '../../schemas/timeblock';

const meta = {
  title: 'Product/Features/Timeblock/TimeblockEditor',
  component: TimeblockEditor,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  argTypes: {
    dateTimeError: { control: 'text' },
  },
} satisfies Meta<typeof TimeblockEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const futureValue: TimeModelEditorValue = {
  note: '',
  activityId: 'activity-1',
  startAt: new Date('2099-07-11T09:00:00'),
  endAt: new Date('2099-07-11T10:00:00'),
  source: 'plan',
};

const pastPlanValue: TimeModelEditorValue = {
  ...futureValue,
  startAt: new Date('2020-07-09T09:00:00'),
  endAt: new Date('2020-07-09T10:00:00'),
};

/** 未来の Plan の日時・メモ編集。 */
export const Plan: Story = {
  args: {
    value: futureValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
  },
  render: function PlanStory() {
    const [value, setValue] = useState(futureValue);
    return (
      <TimeblockEditor
        value={value}
        onDateTimeChange={setValue}
        onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
      />
    );
  },
};

/**
 * Record（記録）の編集。フィールド順はタイトル（アクティビティ）→ 日付・時間 → 充実度
 * （時間の下）→ メモ の順（v1.0 設計書 §6.1、#2412）。
 */
export const Record: Story = {
  args: {
    value: pastPlanValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
  },
  render: function RecordStory() {
    const [value, setValue] = useState<TimeModelEditorValue>({
      ...pastPlanValue,
      source: undefined,
    });
    const [fulfillment, setFulfillment] = useState<Fulfillment | null>('high');
    return (
      <TimeblockEditor
        value={value}
        onDateTimeChange={setValue}
        onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
        fulfillmentSlot={<RecordFulfillmentRow value={fulfillment} onChange={setFulfillment} />}
      />
    );
  },
};

/** 過去の Plan の日時・メモ編集。フィールド順は Record と同じだが充実度は無い。 */
export const PastPlan: Story = {
  args: {
    value: futureValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
  },
  render: function PastPlanStory() {
    const [value, setValue] = useState<TimeModelEditorValue>(pastPlanValue);
    return (
      <TimeblockEditor
        value={value}
        onDateTimeChange={setValue}
        onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
      />
    );
  },
};

/** サイドバー作成と共通の時間重複状態。 */
export const TimeConflict: Story = {
  args: {
    value: futureValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
    dateTimeError: 'この時間帯には既に予定があります',
  },
};

/**
 * 見積もりフィードフォワードのバッジを日時グルーピングの直上に置いた状態。
 * 時間を決める前に目に入る位置なので、グループの中ではなく上に出す。
 */
export const WithEstimationFeedforward: Story = {
  args: {
    value: futureValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
  },
  parameters: {
    trpcMocks: {
      'statistics.getTagEstimationFactors': [
        { activityId: 'activity-1', factor: 1.5, sampleCount: 4 },
      ],
    },
  },
  render: function WithFeedforwardStory() {
    const [value, setValue] = useState(futureValue);
    return (
      <TimeblockEditor
        value={value}
        onDateTimeChange={setValue}
        onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
        beforeDateTimeSlot={
          <EstimationFeedforward
            destination="plan"
            activityId={value.activityId}
            draftMinutes={(value.endAt.getTime() - value.startAt.getTime()) / 60000}
          />
        }
      />
    );
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  args: {
    value: futureValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
  },
  render: function AllPatternsStory() {
    const [value, setValue] = useState(futureValue);
    const [pastValue, setPastValue] = useState(pastPlanValue);
    const [recordValue, setRecordValue] = useState<TimeModelEditorValue>({
      ...pastPlanValue,
      source: undefined,
    });
    const [fulfillment, setFulfillment] = useState<Fulfillment | null>('high');
    return (
      <div className="space-y-6">
        <TimeblockEditor
          value={recordValue}
          onDateTimeChange={setRecordValue}
          onNoteChange={(note) => setRecordValue((current) => ({ ...current, note }))}
          fulfillmentSlot={<RecordFulfillmentRow value={fulfillment} onChange={setFulfillment} />}
        />
        <TimeblockEditor
          value={value}
          onDateTimeChange={setValue}
          onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
        />
        <TimeblockEditor
          value={pastValue}
          onDateTimeChange={setPastValue}
          onNoteChange={(note) => setPastValue((current) => ({ ...current, note }))}
        />
        <TimeblockEditor
          value={value}
          onDateTimeChange={setValue}
          onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
          dateTimeError="この時間帯には既に予定があります"
        />
        <TimeblockEditor
          value={value}
          onDateTimeChange={setValue}
          onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
          disabled
        />
      </div>
    );
  },
};
