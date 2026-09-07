import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { fn, userEvent, within } from 'storybook/test';

import { Command, CommandList } from '@dayopt/components';
import { PRESET_USER_SETTINGS } from '@dayopt/storybook/mocks/presets';

import type { TimeblockSearchResult } from '../../lib/timeblock-search-results';
import { TimeblockSearchContent, TimeblockSearchDialog } from './TimeblockSearchDialog';

const TAGS = [
  {
    id: 'tag-work',
    name: 'Work',
    user_id: 'user-1',
    color: 'blue',
    icon: 'briefcase',
    is_active: true,
    parent_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

function createTimeblockRow(id: string, startAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: 'user-1',
    title: `compatibility-${id}`,
    note: null,
    start_at: startAt,
    end_at: new Date(Date.parse(startAt) + 60 * 60 * 1000).toISOString(),
    created_at: startAt,
    updated_at: startAt,
    deleted_at: null,
    source: 'manual',
    external_calendar_event_id: null,
    ...overrides,
  };
}

const PLANS = [
  createTimeblockRow('plan-1', '2026-07-15T00:00:00.000Z', {
    note: 'Outline the next product iteration',
  }),
  createTimeblockRow('plan-2', '2026-07-13T05:00:00.000Z', {
    note: 'Review the week',
  }),
];

const RECORDS = [
  createTimeblockRow('record-1', '2026-07-14T01:30:00.000Z', {
    note: 'Calendar search states',
  }),
];

const DEFAULT_MOCKS = {
  'userSettings.get': PRESET_USER_SETTINGS.default,
  'plans.list': PLANS,
  'records.list': RECORDS,
};

const meta = {
  title: 'Product/Features/Calendar/Search/TimeblockSearchDialog',
  component: TimeblockSearchDialog,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    trpcMocks: DEFAULT_MOCKS,
  },
  args: {
    open: true,
    onOpenChange: fn(),
    onOpenResult: fn(),
  },
} satisfies Meta<typeof TimeblockSearchDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

async function enterSearch(canvasElement: HTMLElement, query: string) {
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.type(await screen.findByRole('combobox'), query);
}

/** 入力前の案内を表示する。 */
export const Default: Story = {};

/** PlanとRecordを開始日時順に表示する。 */
export const Results: Story = {
  play: async ({ canvasElement }) => enterSearch(canvasElement, 'work'),
};

/** 20件を超える候補では上位20件と絞り込み案内を表示する。 */
export const OverLimit: Story = {
  parameters: {
    trpcMocks: {
      ...DEFAULT_MOCKS,
      'plans.list': Array.from({ length: 21 }, (_, index) =>
        createTimeblockRow(
          `plan-${index + 1}`,
          new Date(Date.UTC(2026, 6, 31 - index, 0, 0)).toISOString(),
          { note: `Search result ${index + 1}` },
        ),
      ),
      'records.list': [],
    },
  },
  play: async ({ canvasElement }) => enterSearch(canvasElement, 'search'),
};

/** 検索結果がない状態。 */
export const Empty: Story = {
  parameters: {
    trpcMocks: { ...DEFAULT_MOCKS, 'plans.list': [], 'records.list': [] },
  },
  play: async ({ canvasElement }) => enterSearch(canvasElement, 'missing'),
};

/** 検索中の状態。 */
export const Loading: Story = {
  parameters: { trpcPending: true },
  play: async ({ canvasElement }) => enterSearch(canvasElement, 'work'),
};

/** 検索に失敗し再試行できる状態。 */
export const Error: Story = {
  parameters: {
    trpcError: { path: 'plans.list', code: 'INTERNAL_SERVER_ERROR' },
  },
  play: async ({ canvasElement }) => enterSearch(canvasElement, 'work'),
};

/** モバイル幅では検索欄を上部に固定した全高Drawerとして表示する。 */
export const MobileDrawer: Story = {
  args: {
    responsive: 'drawer',
  },
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'mobile1' },
  },
  play: async ({ canvasElement }) => enterSearch(canvasElement, 'work'),
};

const STATIC_RESULT: TimeblockSearchResult = {
  kind: 'plan',
  id: 'plan-static',
  note: 'Outline the next product iteration',
  activityId: 'activity-work',
  startAt: '2026-07-15T00:00:00.000Z',
  endAt: '2026-07-15T01:00:00.000Z',
};
/** タグ削除で未分類化した(#1576) 結果。アイコンは中立マーカー(bg-muted + Minus)になる。 */
const STATIC_RESULT_UNCATEGORIZED: TimeblockSearchResult = {
  kind: 'record',
  id: 'record-uncategorized',
  note: 'Tag was deleted after this record was made',
  activityId: null,
  startAt: '2026-07-15T02:00:00.000Z',
  endAt: '2026-07-15T02:45:00.000Z',
};
const STATIC_TAGS = new Map(TAGS.map((tag) => [tag.id, tag]));
const STATIC_CALLBACKS = {
  onOpenResult: fn(),
  onRetry: fn(),
};

function StaticPattern({
  query,
  results,
  isLoading = false,
  isError = false,
  hasMore = false,
}: {
  query: string;
  results: readonly TimeblockSearchResult[];
  isLoading?: boolean;
  isError?: boolean;
  hasMore?: boolean;
}) {
  const hasResultList = query.trim().length > 0 && !isLoading && !isError && results.length > 0;

  return (
    <Command className="border-border h-72 border">
      {hasResultList ? (
        <CommandList className="max-h-none">
          <TimeblockSearchContent
            query={query}
            results={results}
            activitiesById={STATIC_TAGS}
            isLoading={isLoading}
            isError={isError}
            hasMore={hasMore}
            locale="en"
            timezone="Asia/Tokyo"
            timeFormat="24h"
            {...STATIC_CALLBACKS}
          />
        </CommandList>
      ) : (
        <TimeblockSearchContent
          query={query}
          results={results}
          activitiesById={STATIC_TAGS}
          isLoading={isLoading}
          isError={isError}
          hasMore={hasMore}
          locale="en"
          timezone="Asia/Tokyo"
          timeFormat="24h"
          {...STATIC_CALLBACKS}
        />
      )}
    </Command>
  );
}

/** 全表示状態を一覧する。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="grid gap-6 lg:grid-cols-2">
      <StaticPattern query="" results={[]} />
      <StaticPattern query="work" results={[STATIC_RESULT, STATIC_RESULT_UNCATEGORIZED]} hasMore />
      <StaticPattern query="work" results={[]} isLoading />
      <StaticPattern query="work" results={[]} />
      <StaticPattern query="work" results={[]} isError />
    </div>
  ),
};
