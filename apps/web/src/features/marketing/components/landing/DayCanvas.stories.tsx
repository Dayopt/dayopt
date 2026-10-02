import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';

import en from '../../../../../messages/en/marketing.json';
import ja from '../../../../../messages/ja/marketing.json';
import { DayCanvas } from './DayCanvas';

const meta = {
  title: 'Web/Sections/DayCanvas',
  component: DayCanvas,
  parameters: { layout: 'padded' },
  args: { copy: ja.marketing.landing.experience },
  argTypes: { initialStep: { control: 'select', options: ['plan', 'record', 'next'] } },
} satisfies Meta<typeof DayCanvas>;
export default meta;
type Story = StoryObj<typeof meta>;

/** 予定・記録・次の日の3つの表示を確認する。 */
export const AllPatterns: Story = {
  render: (args) => (
    <div className="flex flex-col gap-16">
      {(['plan', 'record', 'next'] as const).map((initialStep) => (
        <DayCanvas key={initialStep} {...args} initialStep={initialStep} />
      ))}
    </div>
  ),
};
/** 30分の予定だけを表示する。 */
export const Plan: Story = { args: { initialStep: 'plan' } };
/** 45分の記録を並べる。 */
export const Record: Story = { args: { initialStep: 'record' } };
/** 前日の記録を手がかりに次の日の予定を表示する。 */
export const NextDay: Story = { args: { initialStep: 'next' } };
/** 英語の表示を確認する。 */
export const English: Story = { args: { copy: en.marketing.landing.experience } };
/** 表示を切り替え、前日の記録を確認して最初の表示に戻す。 */
export const Explore: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: ja.marketing.landing.experience.stepPlan }),
    );
    await expect(canvas.getByText(ja.marketing.landing.experience.pending)).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: ja.marketing.landing.experience.stepNext }),
    );
    await expect(canvas.getByText(ja.marketing.landing.experience.previousRecord)).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: ja.marketing.landing.experience.reset }),
    );
    await expect(
      canvas.getByRole('button', { name: ja.marketing.landing.experience.stepRecord }),
    ).toHaveAttribute('aria-pressed', 'true');
  },
};
