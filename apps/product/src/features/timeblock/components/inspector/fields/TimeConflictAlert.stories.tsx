import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, within } from 'storybook/test';

import { TimeConflictAlert } from './TimeConflictAlert';

/**
 * TimeConflictAlert — 時間重複エラー表示
 *
 * AlertCircle アイコン + エラーメッセージを `role="alert"` で表示する。
 * `aria-live="assertive"` によりスクリーンリーダーに即時通知される。
 */
const meta = {
  title: 'Product/Features/Timeblock/Inspector/TimeConflictAlert',
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** 基本的なエラー表示。 */
export const Default: Story = {
  render: () => (
    <div className="w-72">
      <TimeConflictAlert message="この時間帯には既に予定があります" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = canvas.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(canvas.getByText('この時間帯には既に予定があります')).toBeInTheDocument();
  },
};

/** 開始時刻が終了時刻より後の場合。 */
export const StartAfterEnd: Story = {
  render: () => (
    <div className="w-72">
      <TimeConflictAlert message="開始時刻は終了時刻より前に設定してください" />
    </div>
  ),
};

/** 別のタイムブロックと重複している場合。 */
export const ConflictWithOther: Story = {
  render: () => (
    <div className="w-72">
      <TimeConflictAlert message="別のタイムブロックと時間が重複しています" />
    </div>
  ),
};

/** 長いエラーメッセージ。折り返し動作の確認。 */
export const LongMessage: Story = {
  render: () => (
    <div className="w-72">
      <TimeConflictAlert message="この時間帯には既にスケジュールが登録されています。別の時間帯を選択するか、既存のスケジュールを変更してください。" />
    </div>
  ),
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">Default（基本）</p>
        <TimeConflictAlert message="この時間帯には既に予定があります" />
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">StartAfterEnd（前後逆転）</p>
        <TimeConflictAlert message="開始時刻は終了時刻より前に設定してください" />
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">ConflictWithOther（別タイムブロックと重複）</p>
        <TimeConflictAlert message="別のタイムブロックと時間が重複しています" />
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">LongMessage（長文）</p>
        <TimeConflictAlert message="この時間帯には既にスケジュールが登録されています。別の時間帯を選択するか、既存のスケジュールを変更してください。" />
      </div>
    </div>
  ),
};
