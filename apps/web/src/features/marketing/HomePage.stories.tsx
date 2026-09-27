import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { LandingPage } from './components/landing/LandingPage';

const meta = {
  title: 'Web/Pages/Home',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Ja: Story = {
  render: () => <LandingPage locale="ja" />,
};

export const En: Story = {
  render: () => <LandingPage locale="en" />,
};

export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col gap-12">
      <LandingPage locale="ja" />
      <LandingPage locale="en" />
    </div>
  ),
};
