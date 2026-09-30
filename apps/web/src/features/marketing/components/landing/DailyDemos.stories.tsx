import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';

import en from '../../../../../messages/en/marketing.json';
import ja from '../../../../../messages/ja/marketing.json';
import { CalendarDemo, ClosingMark, TemplateDemo } from './LandingInteractions';

function Demos({ locale }: { locale: 'ja' | 'en' }) {
  const copy = (locale === 'ja' ? ja : en).marketing.landing;
  return (
    <div style={{ display: 'grid', gap: 64 }}>
      <CalendarDemo
        copy={{
          ...copy.calendar,
          plan: copy.hero.plan,
          record: copy.hero.record,
          minuteUnit: copy.hero.minuteUnit,
        }}
      />
      <TemplateDemo copy={{ ...copy.templates, minuteUnit: copy.hero.minuteUnit }} />
      <ClosingMark label={copy.closing.replay} />
    </div>
  );
}

const meta = {
  title: 'Web/Sections/DailyDemos',
  component: Demos,
  parameters: { layout: 'padded' },
  args: { locale: 'ja' },
} satisfies Meta<typeof Demos>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Native controls preserve the same sample data in both locales and themes. */
export const AllPatterns: Story = {};
export const English: Story = { args: { locale: 'en' } };

export const Explore: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const next = canvas.getByRole('radio', { name: ja.marketing.landing.calendar.stepNext });
    await userEvent.click(next);
    await expect(next).toBeChecked();
    await expect(canvas.getByText(ja.marketing.landing.calendar.dateNext)).toBeVisible();
    const apply = canvas.getByText(ja.marketing.landing.templates.apply, { exact: true });
    await userEvent.click(apply);
    await expect(canvas.getByText(ja.marketing.landing.templates.feedbackAfter)).toBeVisible();
    await userEvent.click(canvas.getByText(ja.marketing.landing.templates.reset, { exact: true }));
    await expect(canvas.getByText(ja.marketing.landing.templates.feedbackBefore)).toBeVisible();
  },
};
