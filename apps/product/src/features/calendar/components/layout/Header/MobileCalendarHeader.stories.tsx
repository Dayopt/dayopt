import { addMonths } from 'date-fns';
import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { MobileCalendarHeader } from './MobileCalendarHeader';

/** モバイル専用カレンダーヘッダー。日付タップでインライン展開月グリッドを表示し、タイムラインを押し下げる。 */
const meta = {
  title: 'Product/Features/Calendar/Header/MobileCalendarHeader',
  component: MobileCalendarHeader,
  parameters: {
    layout: 'fullscreen',
  },
  globals: {
    viewport: { value: 'mobile1' },
  },
  tags: ['autodocs'],
  args: {
    currentDate: new Date(2026, 2, 25),
    onNavigate: fn(),
    onDateSelect: fn(),
  },
} satisfies Meta<typeof MobileCalendarHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 折りたたみ状態（デフォルト）。年月とChevronDownが表示される。 */
export const Collapsed: Story = {};

/** 展開状態のスナップショット。検索バー + 月グリッドが表示される。 */
export const Expanded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { expanded: false });
    await userEvent.click(toggle);
    await expect(
      canvas.getByRole('button', { name: /Search blocks|ブロックを検索/i }),
    ).toBeVisible();
  },
};

/** 初期展開状態。タイムライン相当のダミーコンテンツ付きで高さの圧迫感を確認できる。 */
export const ExpandedDefault: Story = {
  render: function ExpandedDefaultStory() {
    const [date, setDate] = useState(new Date(2026, 2, 25));
    return (
      <div className="bg-background h-screen">
        <MobileCalendarHeader
          currentDate={date}
          onNavigate={(dir) => {
            if (dir === 'today') {
              setDate(new Date());
            } else if (dir === 'prev') {
              setDate((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
            } else {
              setDate((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
            }
          }}
          onDateSelect={setDate}
          defaultExpanded
        />
        {/* タイムライン相当のダミーコンテンツ */}
        <div className="divide-border divide-y">
          {Array.from({ length: 12 }, (_, i) => (
            <div
              key={i}
              className="text-muted-foreground flex items-center gap-4 px-4 py-4 text-sm"
            >
              <span className="w-12 shrink-0 text-right tabular-nums">{7 + i}:00</span>
              <div className="bg-muted h-px flex-1" />
            </div>
          ))}
        </div>
      </div>
    );
  },
};

/** グリッドスワイプでヘッダー月テキストが変わるデモ。ボタンで月移動をシミュレート。 */
export const GridSwipe: Story = {
  render: function GridSwipeStory() {
    const [date, setDate] = useState(new Date(2026, 2, 25));
    return (
      <div className="bg-background h-screen">
        <MobileCalendarHeader
          currentDate={date}
          onNavigate={(dir) => {
            if (dir === 'today') {
              setDate(new Date());
            } else if (dir === 'prev') {
              setDate((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
            } else {
              setDate((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
            }
          }}
          onDateSelect={setDate}
        />
        <div className="text-muted-foreground flex gap-2 p-4 text-sm">
          <button
            type="button"
            className="bg-state-hover rounded-lg px-4 py-1"
            onClick={() => setDate((d) => addMonths(d, -1))}
          >
            前月
          </button>
          <button
            type="button"
            className="bg-state-hover rounded-lg px-4 py-1"
            onClick={() => setDate((d) => addMonths(d, 1))}
          >
            次月
          </button>
        </div>
        <div className="text-muted-foreground p-4 text-sm">
          タイムラインコンテンツ（ヘッダー展開時に押し下がる）
        </div>
      </div>
    );
  },
};

/** インタラクティブデモ。日付タップで展開/折りたたみ切替。日付選択後もパネルを維持する。 */
export const Interactive: Story = {
  render: function InteractiveStory() {
    const [date, setDate] = useState(new Date(2026, 2, 25));
    return (
      <div className="bg-background h-screen">
        <MobileCalendarHeader
          currentDate={date}
          onNavigate={(dir) => {
            if (dir === 'today') {
              setDate(new Date());
            } else if (dir === 'prev') {
              setDate((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
            } else {
              setDate((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
            }
          }}
          onDateSelect={setDate}
        />
        <div className="text-muted-foreground p-4 text-sm">
          タイムラインコンテンツ（ヘッダー展開時に押し下がる）
        </div>
      </div>
    );
  },
};

/** 折りたたみ・展開状態の一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="grid gap-6">
      <article>
        <MobileCalendarHeader
          currentDate={new Date(2026, 2, 25)}
          onNavigate={fn()}
          onDateSelect={fn()}
        />
      </article>
      <article>
        <MobileCalendarHeader
          currentDate={new Date(2026, 2, 25)}
          onNavigate={fn()}
          onDateSelect={fn()}
          defaultExpanded
        />
      </article>
    </div>
  ),
};
