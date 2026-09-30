import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';

import en from '../../../../../messages/en/marketing.json';
import ja from '../../../../../messages/ja/marketing.json';
import { WeekTrace } from './WeekTrace';

const meta = {
  title: 'Web/Sections/WeekTrace',
  component: WeekTrace,
  parameters: { layout: 'padded' },
  args: {
    copy: {
      label: ja.marketing.landing.review.traceLabel,
      days: ja.marketing.landing.review.days,
      plan: ja.marketing.landing.hero.plan,
      record: ja.marketing.landing.hero.record,
      minuteUnit: ja.marketing.landing.hero.minuteUnit,
      scale: ja.marketing.landing.review.traceScale,
    },
  },
} satisfies Meta<typeof WeekTrace>;
export default meta;
type Story = StoryObj<typeof meta>;

/** 7日分の予定と記録を、同じ尺度で並べる。 */
export const AllPatterns: Story = {};

/** 英語の表示を確認する。 */
export const English: Story = {
  args: {
    copy: {
      label: en.marketing.landing.review.traceLabel,
      days: en.marketing.landing.review.days,
      plan: en.marketing.landing.hero.plan,
      record: en.marketing.landing.hero.record,
      minuteUnit: en.marketing.landing.hero.minuteUnit,
      scale: en.marketing.landing.review.traceScale,
    },
  },
};

/** 日を選び、予定と記録の独立した長さを確かめる。 */
export const Explore: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wednesday = canvas.getByRole('radio', { name: /水:/ });
    await userEvent.click(wednesday);
    await expect(wednesday).toBeChecked();
    const detail = canvasElement.querySelector('figcaption [data-index="2"]');
    await expect(detail).toBeVisible();
    await expect(detail).toHaveTextContent('150');
    await expect(detail).toHaveTextContent('135');
  },
};
