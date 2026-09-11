import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import type { CalendarDisplayEvent } from '../../../../types/calendar.types';
import { EventContextMenu } from './TimeblockContextMenu';

// ─────────────────────────────────────────────────────────
// サンプルデータ
// ─────────────────────────────────────────────────────────

const past = new Date('2026-03-18T10:00:00');
const pastEnd = new Date('2026-03-18T11:00:00');

/** 完了済み planned entry（全項目表示の前提） */
const completedPlannedEntry: CalendarDisplayEvent = {
  id: 'entry-1',
  kind: 'plan',
  title: 'デザインレビュー',
  description: '週次デザインシンク',
  startDate: past,
  endDate: pastEnd,
  status: 'closed',
  color: 'var(--primary)',
  createdAt: new Date(),
  updatedAt: new Date(),
  version: '2026-07-15T00:00:00.000000Z',
  displayStartDate: past,
  displayEndDate: pastEnd,
  duration: 60,
  isMultiDay: false,
  actualStartDate: past,
  actualEndDate: pastEnd,
};

/** タグなし entry（振り返り非表示） */
const noTagEntry: CalendarDisplayEvent = {
  ...completedPlannedEntry,
  id: 'entry-2',
};

/** 未来の planned entry（記録が存在し得ないため「予定外にする」非表示） */
const futureStart = new Date('2099-01-01T10:00:00');
const futureEnd = new Date('2099-01-01T11:00:00');
const upcomingPlannedEntry: CalendarDisplayEvent = {
  ...completedPlannedEntry,
  id: 'entry-3',
  startDate: futureStart,
  endDate: futureEnd,
  displayStartDate: futureStart,
  displayEndDate: futureEnd,
  plannedStartDate: futureStart,
  plannedEndDate: futureEnd,
  actualStartDate: null,
  actualEndDate: null,
};

/** Unplanned entry（計画に戻す表示） */
const unplannedEntry: CalendarDisplayEvent = {
  ...completedPlannedEntry,
  id: 'entry-4',
  kind: 'record',
};

/** エントリコンテキストメニュー。右クリックメニューとして使用する。 */
const meta = {
  title: 'Product/Features/Calendar/Interaction/TimeblockContextMenu',
  component: EventContextMenu,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    entry: completedPlannedEntry,
    position: { x: 0, y: 0 },
    onClose: fn(),
  },
  argTypes: {
    onDuplicate: { control: false },
  },
} satisfies Meta<typeof EventContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────

/** 右クリックでコンテキストメニューを開くラッパー。 */
function ContextMenuTrigger({
  entry,
  menuProps,
}: {
  entry: CalendarDisplayEvent;
  menuProps?: Partial<React.ComponentProps<typeof EventContextMenu>>;
}) {
  const [menuState, setMenuState] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      className="border-border bg-muted relative flex h-40 w-full cursor-context-menu items-center justify-center rounded-lg border"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuState({ x: e.clientX, y: e.clientY });
      }}
    >
      <span className="text-muted-foreground text-sm">右クリックでメニューを開く</span>
      {menuState && (
        <EventContextMenu
          entry={entry}
          position={menuState}
          onClose={() => setMenuState(null)}
          {...menuProps}
        />
      )}
    </div>
  );
}

const allHandlers = {
  onDelete: fn(),
  onViewStats: fn(),
  onCopy: fn(),
  onDuplicate: fn(),
};

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** デフォルト（全項目あり：完了済み planned entry）。 */
export const Default: Story = {
  render: () => <ContextMenuTrigger entry={completedPlannedEntry} menuProps={allHandlers} />,
};

/** コピー・複製と削除。 */
export const CopyAndDelete: Story = {
  render: () => (
    <ContextMenuTrigger
      entry={completedPlannedEntry}
      menuProps={{
        onCopy: fn(),
        onDuplicate: fn(),
        onDelete: fn(),
      }}
    />
  ),
};

/** 直接表示（位置固定）。 */
export const DirectDisplay: Story = {
  render: () => (
    <div className="relative" style={{ height: 300 }}>
      <EventContextMenu
        entry={completedPlannedEntry}
        position={{ x: 20, y: 20 }}
        onClose={fn()}
        {...allHandlers}
      />
    </div>
  ),
};

/** 全パターン一覧（直接表示で各構成を確認）。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">完了済み planned（全項目）</span>
        <div className="relative" style={{ height: 180 }}>
          <EventContextMenu
            entry={completedPlannedEntry}
            position={{ x: 0, y: 0 }}
            onClose={fn()}
            {...allHandlers}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">タグなし（振り返り非表示）</span>
        <div className="relative" style={{ height: 140 }}>
          <EventContextMenu
            entry={noTagEntry}
            position={{ x: 0, y: 0 }}
            onClose={fn()}
            {...allHandlers}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">未来の予定（予定外にする非表示）</span>
        <div className="relative" style={{ height: 140 }}>
          <EventContextMenu
            entry={upcomingPlannedEntry}
            position={{ x: 0, y: 0 }}
            onClose={fn()}
            {...allHandlers}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">Unplanned（計画に戻す表示）</span>
        <div className="relative" style={{ height: 180 }}>
          <EventContextMenu
            entry={unplannedEntry}
            position={{ x: 0, y: 0 }}
            onClose={fn()}
            {...allHandlers}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">コピー・複製と削除</span>
        <div className="relative" style={{ height: 80 }}>
          <EventContextMenu
            entry={completedPlannedEntry}
            position={{ x: 0, y: 0 }}
            onClose={fn()}
            onCopy={fn()}
            onDuplicate={fn()}
            onDelete={fn()}
          />
        </div>
      </div>
    </div>
  ),
};
