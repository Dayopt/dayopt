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
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm">
        <Story />
      </div>
    ),
  ],
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

const recordStoryValue: TimeModelEditorValue = {
  ...pastPlanValue,
  note: '運動に集中できて、気分よく過ごせた。\n水分を取ってから始めた。',
  source: undefined,
};

const longMemoValue: TimeModelEditorValue = {
  ...recordStoryValue,
  note: [
    '午前の定例で確認する項目を整理する。',
    '前回のレビューで出た質問への回答を用意する。',
    '仕様の変更点を関係者に共有する。',
    '見積もりと実装の順序を確認する。',
    '関連するテストケースを更新する。',
    'レビュー依頼の前に変更差分を読み直す。',
    '未決の点はIssueに記録して担当を決める。',
    '次回の確認時間をカレンダーに追加する。',
    '午後に実装を進め、終わったら結果を共有する。',
    '最後に残作業と次の予定を整理する。',
  ].join('\n'),
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

/** 記録の詳細。日付・時間・充実度・入力済みメモを同じグループに表示。 */
export const Record: Story = {
  args: {
    value: recordStoryValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
  },
  render: function RecordStory() {
    const [value, setValue] = useState(recordStoryValue);
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

/** 過去の Plan の日時・メモ編集。Record と同じグループで、充実度は無い。 */
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

/** 長い記録メモは入力に合わせて伸び、Inspector全体がスクロールする。 */
export const LongMemoScroll: Story = {
  args: {
    value: longMemoValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
  },
  render: function LongMemoScrollStory() {
    const [value, setValue] = useState(longMemoValue);
    const [fulfillment, setFulfillment] = useState<Fulfillment | null>('high');
    return (
      <div className="border-border h-[70vh] min-h-0 overflow-y-auto rounded-2xl border p-4">
        <TimeblockEditor
          value={value}
          onDateTimeChange={setValue}
          onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
          fulfillmentSlot={<RecordFulfillmentRow value={fulfillment} onChange={setFulfillment} />}
        />
      </div>
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
      'statistics.getActivityEstimationFactors': [
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

/** 予定・記録のメモ欄と各入力状態。 */
export const AllPatterns: Story = {
  args: {
    value: futureValue,
    onDateTimeChange: () => undefined,
    onNoteChange: () => undefined,
  },
  render: function AllPatternsStory() {
    const [value, setValue] = useState(futureValue);
    const [pastValue, setPastValue] = useState(pastPlanValue);
    const [recordValue, setRecordValue] = useState(longMemoValue);
    const [fulfillment, setFulfillment] = useState<Fulfillment | null>('high');
    return (
      <div className="max-h-[70vh] space-y-6 overflow-y-auto">
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
