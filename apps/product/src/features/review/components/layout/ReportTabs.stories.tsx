import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { ReportTabs } from './ReportTabs';

import type { ReportTab } from '../../lib/report-tab';

/**
 * `/report` の面の切替。期間の軸（ヘッダー）とは独立していて、URL の `?tab=` に載る。
 */
const meta = {
  title: 'Product/Features/Review/Layout/ReportTabs',
  component: ReportTabs,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: { value: 'usage', onValueChange: () => {} },
} satisfies Meta<typeof ReportTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 既定。時間の使い方が選ばれている。 */
export const Default: Story = {};

/** 差分を選んだ状態。 */
export const Diff: Story = { args: { value: 'diff' } };

/** すべての状態を 1 画面に並べる（ADR-023 の AllPatterns）。下段は最小幅（320px）。 */
export const AllPatterns: Story = {
  render: function AllPatternsReportTabs() {
    const [value, setValue] = useState<ReportTab>('reflect');
    return (
      <div className="flex flex-col gap-6">
        <ReportTabs value="usage" onValueChange={() => {}} />
        <ReportTabs value="diff" onValueChange={() => {}} />
        <ReportTabs value={value} onValueChange={setValue} />
        <div className="w-[320px]">
          <ReportTabs value="usage" onValueChange={() => {}} />
        </div>
      </div>
    );
  },
};
