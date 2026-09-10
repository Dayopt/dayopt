import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { TimeColumn } from './TimeColumn';

/**
 * 時間列コンポーネント（グリッド左側の時間ラベル表示）。
 * 24時間/12時間表示切替、時間範囲指定、密度調整に対応。
 */
const meta = {
  title: 'Product/Features/Calendar/Grid/TimeColumn',
  component: TimeColumn,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    a11y: { test: 'todo' },
  },
  args: {
    startHour: 0,
    endHour: 24,
    hourHeight: 72,
    format: '24h',
  },
} satisfies Meta<typeof TimeColumn>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** 24時間表示（デフォルト）。0:00〜23:00。 */
export const TwentyFourHour: Story = {
  args: {
    format: '24h',
    startHour: 0,
    endHour: 24,
    hourHeight: 72,
  },
  decorators: [
    (Story) => (
      <div className="border-border h-[500px] overflow-y-auto rounded-lg border">
        <Story />
      </div>
    ),
  ],
};

/** 12時間表示（AM/PM）。 */
export const TwelveHour: Story = {
  args: {
    format: '12h',
    startHour: 0,
    endHour: 24,
    hourHeight: 72,
  },
  decorators: [
    (Story) => (
      <div className="border-border h-[500px] overflow-y-auto rounded-lg border">
        <Story />
      </div>
    ),
  ],
};

/** 業務時間帯のみ（8時〜19時）。 */
export const BusinessHours: Story = {
  args: {
    format: '24h',
    startHour: 8,
    endHour: 19,
    hourHeight: 72,
  },
  decorators: [
    (Story) => (
      <div className="border-border h-[500px] overflow-y-auto rounded-lg border">
        <Story />
      </div>
    ),
  ],
};

/** コンパクト密度（hourHeight: 48px）。 */
export const Compact: Story = {
  args: {
    format: '24h',
    startHour: 0,
    endHour: 24,
    hourHeight: 48,
  },
  decorators: [
    (Story) => (
      <div className="border-border h-[500px] overflow-y-auto rounded-lg border">
        <Story />
      </div>
    ),
  ],
};

/** ゆったり密度（hourHeight: 96px）。 */
export const Spacious: Story = {
  args: {
    format: '24h',
    startHour: 0,
    endHour: 24,
    hourHeight: 96,
  },
  decorators: [
    (Story) => (
      <div className="border-border h-[500px] overflow-y-auto rounded-lg border">
        <Story />
      </div>
    ),
  ],
};

/**
 * モバイル密度（dense）。幅 48px にラベルを一段小さくして収め、左右 8px の余白を保つ。
 * 12 時間表記は `12:00 PM` が長いため 72px を使う。
 */
export const Dense: Story = {
  args: {
    format: '24h',
    startHour: 0,
    endHour: 24,
    hourHeight: 72,
    dense: true,
  },
  decorators: [
    (Story) => (
      <div className="border-border h-[500px] w-fit overflow-y-auto rounded-lg border">
        <Story />
      </div>
    ),
  ],
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex items-start gap-6">
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">24時間表示</p>
        <div className="border-border h-[400px] overflow-y-auto rounded-lg border">
          <TimeColumn format="24h" startHour={6} endHour={22} hourHeight={72} />
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">モバイル密度 24h（48px）</p>
        <div className="border-border h-[400px] w-fit overflow-y-auto rounded-lg border">
          <TimeColumn format="24h" startHour={6} endHour={22} hourHeight={72} dense />
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">モバイル密度 12h（72px）</p>
        <div className="border-border h-[400px] w-fit overflow-y-auto rounded-lg border">
          <TimeColumn format="12h" startHour={6} endHour={22} hourHeight={72} dense />
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">12時間表示</p>
        <div className="border-border h-[400px] overflow-y-auto rounded-lg border">
          <TimeColumn format="12h" startHour={6} endHour={22} hourHeight={72} />
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">コンパクト（48px）</p>
        <div className="border-border h-[400px] overflow-y-auto rounded-lg border">
          <TimeColumn format="24h" startHour={6} endHour={22} hourHeight={48} />
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">ゆったり（96px）</p>
        <div className="border-border h-[400px] overflow-y-auto rounded-lg border">
          <TimeColumn format="24h" startHour={6} endHour={22} hourHeight={96} />
        </div>
      </div>
    </div>
  ),
};
