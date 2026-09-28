import { useState, type ComponentProps, type ReactNode } from 'react';

import { FloatingActionBarItem } from '@dayopt/components';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Check, Clock3, Ellipsis } from 'lucide-react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { TimeblockEditor, type TimeModelEditorValue } from './TimeblockEditor';
import {
  ConfirmDayButton,
  RecordPlanButton,
  TimeblockRecordActions,
} from './TimeblockRecordActions';

const planId = '00000000-0000-4000-8000-000000000001';

function prepareRecord(): Promise<string> {
  return Promise.resolve('2026-07-01T00:00:00.000001Z');
}

function waitForPreparation(): Promise<string> {
  return new Promise(() => undefined);
}

const blockValue: TimeModelEditorValue = {
  activityId: planId,
  note: '',
  startAt: new Date('2020-07-14T09:00:00'),
  endAt: new Date('2020-07-14T10:00:00'),
  source: 'plan',
};

const onDraftAction = fn();
const draftIcons = [Check, Clock3, Ellipsis];

function DraftActionButtons({ disabled = false }: { disabled?: boolean }) {
  return (
    <>
      {draftIcons.map((Icon, index) => (
        <FloatingActionBarItem
          key={index}
          type="button"
          disabled={disabled}
          onClick={onDraftAction}
        >
          <Icon className="size-4" aria-hidden="true" />
          {`ボタン${index + 1}`}
        </FloatingActionBarItem>
      ))}
    </>
  );
}

function BlockPreview({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  const [value, setValue] = useState(blockValue);

  return (
    <div className="space-y-3">
      <TimeblockEditor
        value={value}
        onDateTimeChange={setValue}
        onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
        disabled={disabled}
      />
      <TimeblockRecordActions>{children}</TimeblockRecordActions>
    </div>
  );
}

function RecordActionsPreview(args: ComponentProps<typeof RecordPlanButton>) {
  const [value, setValue] = useState(blockValue);
  const [isPreparing, setIsPreparing] = useState(false);

  return (
    <div className="space-y-3">
      <TimeblockEditor
        value={value}
        onDateTimeChange={setValue}
        onNoteChange={(note) => setValue((current) => ({ ...current, note }))}
        disabled={args.disabled || isPreparing}
      />
      <TimeblockRecordActions>
        <RecordPlanButton
          {...args}
          onPreparingChange={(next) => {
            setIsPreparing(next);
            args.onPreparingChange?.(next);
          }}
        />
      </TimeblockRecordActions>
    </div>
  );
}

const meta = {
  title: 'Product/Features/Timeblock/TimeblockRecordActions',
  component: TimeblockRecordActions,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  args: {
    children: <DraftActionButtons />,
  },
  argTypes: { children: { control: false } },
  render: (args) => <BlockPreview>{args.children}</BlockPreview>,
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeblockRecordActions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** ブロックから離したカプセル状のバーに、アイコン付きの3操作を配置するUI案。 */
export const Default: Story = {};

/** 外部条件による無効状態。 */
export const Disabled: Story = {
  render: () => (
    <BlockPreview disabled>
      <DraftActionButtons disabled />
    </BlockPreview>
  ),
};

/** 現在の記録操作をブロック直下に配置した状態。 */
export const RecordAsPlanned: Story = {
  render: () => <RecordActionsPreview planId={planId} beforeRecord={prepareRecord} />,
};

/** 最新編集の保存完了を待つ状態。 */
export const Preparing: Story = {
  render: () => <RecordActionsPreview planId={planId} beforeRecord={waitForPreparation} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: /そのまま記録|Record as planned/ });
    await userEvent.click(button);
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="space-y-6">
      <BlockPreview>
        <DraftActionButtons />
      </BlockPreview>
      <BlockPreview disabled>
        <DraftActionButtons disabled />
      </BlockPreview>
      <RecordActionsPreview planId={planId} beforeRecord={prepareRecord} />
      <ConfirmDayButton
        startAt={new Date('2026-07-14T00:00:00.000Z')}
        endAt={new Date('2026-07-15T00:00:00.000Z')}
      />
    </div>
  ),
};
