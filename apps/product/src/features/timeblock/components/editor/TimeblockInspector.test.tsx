import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicPlanRow, PublicRecordRow } from '@/lib/database';

import { useTimeblockInspectorStore } from '../../stores/useTimeblockInspectorStore';

import { TimeblockInspector } from './TimeblockInspector';

const mocks = vi.hoisted(() => ({
  planGetById: vi.fn(),
  recordGetById: vi.fn(),
  recordsList: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/features/activities', () => ({
  useActivitiesMap: () => ({
    getActivityById: (activityId: string) =>
      activityId === 'activity-1'
        ? { id: activityId, name: 'Work', color: 'blue', icon: null }
        : undefined,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    plans: {
      getById: { useQuery: mocks.planGetById },
    },
    records: {
      getById: { useQuery: mocks.recordGetById },
      list: { useQuery: mocks.recordsList },
    },
  },
}));

vi.mock('../../hooks/useInspectorURLSync', () => ({
  useInspectorURLSync: () => undefined,
}));

vi.mock('../inspector/hooks', () => ({
  useInspectorKeyboard: () => undefined,
}));

vi.mock('../inspector/DockedInspectorPanel', () => ({
  DockedInspectorPanel: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div role="region" aria-label={title}>
      {children}
    </div>
  ),
}));

vi.mock('./TimeblockInspectorForm', () => ({
  TimeblockInspectorForm: ({
    kind,
    duplicateDraft,
    relationships,
    onOpenRelationship,
    onCancelDuplicate,
  }: {
    kind: 'plan' | 'record';
    duplicateDraft?: { sourceId: string };
    relationships?:
      | { kind: 'plan'; status: string; records: Array<{ id: string }> }
      | { kind: 'record'; status: string; plan: { id: string } | null };
    onOpenRelationship?: (id: string, kind: 'plan' | 'record') => void;
    onCancelDuplicate?: () => void;
  }) => (
    <div>
      <output data-testid="inspector-kind">{kind}</output>
      <output data-testid="inspector-mode">{duplicateDraft ? 'duplicate' : 'view'}</output>
      <output data-testid="relationship-status">{relationships?.status ?? 'none'}</output>
      <output data-testid="relationship-kind">{relationships?.kind ?? 'none'}</output>
      <button
        type="button"
        onClick={() =>
          onOpenRelationship?.(
            kind === 'plan' ? 'record-1' : 'plan-1',
            kind === 'plan' ? 'record' : 'plan',
          )
        }
      >
        open-related
      </button>
      <button type="button" onClick={onCancelDuplicate}>
        cancel-duplicate
      </button>
    </div>
  ),
}));

const plan = {
  id: 'plan-1',
  user_id: 'user-1',
  activity_id: 'activity-1',
  external_calendar_event_id: null,
  title: 'Legacy plan title',
  note: null,
  start_at: '2026-07-14T09:00:00.000Z',
  end_at: '2026-07-14T10:00:00.000Z',

  source: 'manual',
  deleted_at: null,
  created_at: '2026-07-14T08:00:00.000Z',
  updated_at: '2026-07-14T08:00:00.000Z',
} satisfies PublicPlanRow;

const record = {
  id: 'record-1',
  user_id: 'user-1',
  activity_id: 'activity-1',

  external_calendar_event_id: null,
  title: 'Legacy record title',
  note: null,
  start_at: '2026-07-14T09:05:00.000Z',
  end_at: '2026-07-14T09:55:00.000Z',
  source: 'from_plan',
  fulfillment: null,
  deleted_at: null,
  created_at: '2026-07-14T10:00:00.000Z',
  updated_at: '2026-07-14T10:00:00.000Z',
} satisfies PublicRecordRow;

function success<T>(data: T) {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isSuccess: true,
    refetch: vi.fn(),
  };
}

describe('TimeblockInspector relationships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planGetById.mockImplementation((input: { id: string }, options: { enabled: boolean }) => {
      if (!options.enabled) return success(undefined);
      return success(input.id === plan.id ? plan : undefined);
    });
    mocks.recordGetById.mockImplementation((input: { id: string }) =>
      success(input.id === record.id ? record : undefined),
    );
    mocks.recordsList.mockReturnValue(success([record]));
  });

  afterEach(() => {
    act(() => useTimeblockInspectorStore.getState().closeInspector());
  });

  it('Planの関連Recordを取得し、同じInspectorでRecordへ切り替えてfocusを戻す', async () => {
    const user = userEvent.setup();
    act(() => useTimeblockInspectorStore.getState().openInspector(plan.id, 'plan'));
    render(<TimeblockInspector />);

    expect(screen.getByRole('region', { name: 'Work' })).toBeInTheDocument();
    expect(screen.getByTestId('inspector-kind')).toHaveTextContent('plan');
    expect(screen.getByTestId('relationship-kind')).toHaveTextContent('plan');
    expect(mocks.recordsList).toHaveBeenCalledWith(
      { startDate: plan.start_at, endDate: plan.end_at, sortBy: 'start_at', sortOrder: 'asc' },
      expect.objectContaining({ enabled: true }),
    );

    await user.click(screen.getByRole('button', { name: 'open-related' }));

    expect(screen.getByTestId('inspector-kind')).toHaveTextContent('record');
    expect(screen.getByTestId('relationship-kind')).toHaveTextContent('none');
    await waitFor(() => expect(screen.getByRole('button', { name: 'open-related' })).toHaveFocus());
    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      timeblockId: record.id,
      timeblockKind: 'record',
    });
  });

  it('記録詳細は元の予定を取得しない', () => {
    act(() => useTimeblockInspectorStore.getState().openInspector(record.id, 'record'));
    render(<TimeblockInspector />);
    expect(screen.getByTestId('relationship-status')).toHaveTextContent('none');
    expect(mocks.planGetById.mock.calls.some(([, options]) => options.enabled)).toBe(false);
  });

  it('複製下書きを直接表示し、キャンセルで元ブロックの詳細へ戻る', async () => {
    const user = userEvent.setup();
    act(() =>
      useTimeblockInspectorStore.getState().openDuplicate({
        sourceId: plan.id,
        kind: 'plan',
        title: plan.title,
        note: plan.note,
        activityId: plan.activity_id,
        startAt: plan.start_at,
        endAt: plan.end_at,
      }),
    );
    render(<TimeblockInspector />);

    expect(screen.getByRole('region', { name: 'Work' })).toBeInTheDocument();
    expect(screen.getByTestId('inspector-mode')).toHaveTextContent('duplicate');
    expect(mocks.planGetById).toHaveBeenCalledWith(
      { id: plan.id },
      expect.objectContaining({ enabled: false }),
    );

    await user.click(screen.getByRole('button', { name: 'cancel-duplicate' }));

    expect(screen.getByTestId('inspector-mode')).toHaveTextContent('view');
    expect(useTimeblockInspectorStore.getState().duplicateDraft).toBeNull();
  });
});
