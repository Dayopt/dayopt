import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicPlanRow, PublicRecordRow } from '@/lib/database';

import { createTimeblockDuplicateDraft } from '../../lib/timeblock-duplicate';
import { TimeblockInspectorForm } from './TimeblockInspectorForm';

const mocks = vi.hoisted(() => ({
  enqueueSave: vi.fn(),
  flushSave: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  createPlanMutate: vi.fn(),
  createRecordMutate: vi.fn(),
  deletePlanMutateAsync: vi.fn(),
  restorePlanMutateAsync: vi.fn(),
  canUseProduct: true,
  onCreateTimeOverlap: undefined as (() => void) | undefined,
  onUpdateTimeOverlap: undefined as
    | ((input: {
        id: string;
        data: { start_at?: string | undefined; end_at?: string | undefined };
      }) => void)
    | undefined,
  cachedPlans: [] as Array<{ id: string; start_at: string; end_at: string }>,
  cachedRecords: [] as Array<{ id: string; start_at: string; end_at: string }>,
}));

vi.mock('@/lib/billing/BillingAccessProvider', () => ({
  useBillingAccess: () => ({
    state: mocks.canUseProduct ? 'trial' : 'expired',
    canUseProduct: mocks.canUseProduct,
    trialEndsAt: null,
    enforced: true,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueriesData: ({ predicate }: { predicate: (query: { queryKey: unknown }) => boolean }) => {
      const entries: Array<[unknown, Array<{ id: string; start_at: string; end_at: string }>]> = [
        [[['plans', 'list'], { input: {} }], mocks.cachedPlans],
        [[['records', 'list'], { input: {} }], mocks.cachedRecords],
      ];
      return entries.filter(([queryKey]) => predicate({ queryKey }));
    },
  }),
}));

vi.mock('@/features/activities', () => ({
  ActivityIcon: () => null,
  ActivityQuickSelector: () => null,
  getCategoryColorClasses: vi.fn(),
  resolveCategoryColor: (color: string | null | undefined) => color ?? 'gray',
  useCreateActivity: () => ({ mutateAsync: vi.fn() }),
  useActivitiesMap: () => ({ getActivityById: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock('../../hooks/useCoalescedTimeblockSave', () => ({
  useCoalescedTimeblockSave: () => ({
    enqueue: mocks.enqueueSave,
    flush: mocks.flushSave,
  }),
}));

vi.mock('../../hooks/useTimeblockWriteMutations', () => ({
  isTimeblockStaleError: () => false,
  isTimeblockUncertainError: () => false,
  useTimeblockWriteMutations: (options?: {
    onCreateTimeOverlap?: () => void;
    onUpdateTimeOverlap?: (input: {
      id: string;
      data: { start_at?: string | undefined; end_at?: string | undefined };
    }) => void;
  }) => {
    mocks.onCreateTimeOverlap = options?.onCreateTimeOverlap;
    mocks.onUpdateTimeOverlap = options?.onUpdateTimeOverlap;
    const mutation = {
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
    };
    return {
      createRecord: { ...mutation, mutate: mocks.createRecordMutate },
      createPlan: { ...mutation, mutate: mocks.createPlanMutate },
      deleteRecord: mutation,
      deletePlan: { ...mutation, mutateAsync: mocks.deletePlanMutateAsync },
      fetchPlanById: vi.fn(),
      fetchRecordById: vi.fn(),
      restoreRecord: mutation,
      restorePlan: { ...mutation, mutateAsync: mocks.restorePlanMutateAsync },
      updateRecord: mutation,
      updatePlan: mutation,
    };
  },
}));

// 選択一覧へ渡す「普段の長さ」。集計そのものは statistics service 側で検証済み
vi.mock('../../hooks/useActivityMedianDurations', () => ({
  useActivityMedianDurations: () => ({
    medianByActivityId: new Map([['activity-2', 45]]),
    getMedianMinutes: () => 45,
  }),
}));

vi.mock('../inspector/fields', () => ({
  ActivityFieldRow: ({
    activityName,
    onActivityChange,
    durationByActivityId,
  }: {
    activityName: string;
    onActivityChange: (activityId: string | null) => void;
    durationByActivityId?: ReadonlyMap<string, number> | undefined;
  }) => (
    <>
      <button type="button" onClick={() => onActivityChange('activity-2')}>
        {activityName}
      </button>
      <span data-testid="activity-median">{durationByActivityId?.get('activity-2') ?? 'none'}</span>
    </>
  ),
  InspectorHeaderActions: ({
    menuItems,
  }: {
    menuItems?: Array<{ key: string; onSelect: () => void }>;
  }) => (
    <>
      {menuItems?.map((item) => (
        <button key={item.key} type="button" onClick={item.onSelect}>
          {item.key}
        </button>
      ))}
    </>
  ),
  RecordFulfillmentRow: ({
    value,
    onChange,
    disabled,
  }: {
    value: 'low' | 'medium' | 'high' | null;
    onChange: (next: 'low' | 'medium' | 'high' | null) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid="record-fulfillment-row"
      data-value={value ?? ''}
      disabled={disabled}
      onClick={() => onChange('high')}
    >
      fulfillment
    </button>
  ),
}));

vi.mock('./TimeblockRecordActions', () => ({
  RecordPlanButton: ({
    beforeRecord,
    onRecorded,
  }: {
    beforeRecord: () => Promise<string>;
    onRecorded?: (recordId: string) => void;
  }) => (
    <>
      <button type="button" onClick={() => void beforeRecord()}>
        prepare-record
      </button>
      <button type="button" onClick={() => onRecorded?.('record-created')}>
        complete-record
      </button>
    </>
  ),
}));

vi.mock('./TimeblockRelationshipSection', () => ({
  TimeblockRelationshipSection: () => null,
}));

// 作成時フィードフォワードは自身の test が挙動を固定する。ここでは配線
// （どの destination / activityId / draftMinutes が渡るか）だけを見える化する。
vi.mock('./EstimationFeedforward', () => ({
  EstimationFeedforward: ({
    destination,
    activityId,
    draftMinutes,
  }: {
    destination: 'plan' | 'record';
    activityId: string | null;
    draftMinutes: number;
  }) => (
    <output data-testid="feedforward-props">{`${destination}/${activityId ?? 'none'}/${draftMinutes}`}</output>
  ),
}));

vi.mock('./TimeblockEditor', () => ({
  isValidTimeModelRange: ({ startAt, endAt }: { startAt: Date; endAt: Date }) =>
    startAt.getTime() < endAt.getTime(),
  TimeblockEditor: ({
    value,
    onDateTimeChange,
    onNoteChange,
    dateTimeError,
    beforeDateTimeSlot,
  }: {
    value: {
      note: string;
      startAt: Date;
      endAt: Date;
      source?: 'plan' | 'record';
    };
    onDateTimeChange: (next: {
      note: string;
      startAt: Date;
      endAt: Date;
      source?: 'plan' | 'record';
    }) => void;
    onNoteChange: (note: string) => void;
    dateTimeError?: string;
    beforeDateTimeSlot?: React.ReactNode;
  }) => (
    <>
      {/* 実物と同じく日時グルーピングの上に置く（フィードフォワードの配線を見える化する） */}
      {beforeDateTimeSlot}
      <output data-testid="current-end">{value.endAt.toISOString()}</output>
      {dateTimeError ? <output data-testid="date-time-error">{dateTimeError}</output> : null}
      <button
        type="button"
        onClick={() =>
          onDateTimeChange({
            ...value,
            startAt: new Date('2026-07-15T11:00:00.000Z'),
            endAt: new Date('2026-07-15T12:00:00.000Z'),
          })
        }
      >
        move-to-now
      </button>
      <button type="button" onClick={() => onNoteChange('最新メモ')}>
        edit-note
      </button>
      <button
        type="button"
        onClick={() =>
          onDateTimeChange({
            ...value,
            startAt: new Date('2026-07-15T15:00:00.000Z'),
            endAt: new Date('2026-07-15T16:00:00.000Z'),
          })
        }
      >
        move-to-future
      </button>
      <button
        type="button"
        onClick={() =>
          onDateTimeChange({
            ...value,
            startAt: new Date('2026-07-15T07:00:00.000Z'),
            endAt: new Date('2026-07-15T08:00:00.000Z'),
          })
        }
      >
        move-to-past
      </button>
    </>
  ),
}));

const futurePlan = {
  id: 'plan-1',
  user_id: 'user-1',
  activity_id: null,
  external_calendar_event_id: null,
  title: 'Future plan',
  note: null,
  start_at: '2026-07-15T13:00:00.000Z',
  end_at: '2026-07-15T14:00:00.000Z',

  source: 'manual',
  deleted_at: null,
  created_at: '2026-07-15T10:00:00.000Z',
  updated_at: '2026-07-15T10:00:00.000Z',
} satisfies PublicPlanRow;

const pastPlan = {
  ...futurePlan,
  start_at: '2026-07-15T10:00:00.000Z',
  end_at: '2026-07-15T11:00:00.000Z',
} satisfies PublicPlanRow;

const relatedRecord = {
  id: 'record-1',
  user_id: 'user-1',
  activity_id: null,

  external_calendar_event_id: null,
  title: 'Recorded work',
  note: null,
  start_at: '2026-07-15T10:00:00.000Z',
  end_at: '2026-07-15T11:00:00.000Z',
  source: 'from_plan',
  fulfillment: null,
  deleted_at: null,
  created_at: '2026-07-15T10:00:00.000Z',
  updated_at: '2026-07-15T10:00:00.000Z',
} satisfies PublicRecordRow;

describe('TimeblockInspectorForm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
    vi.clearAllMocks();
    mocks.createPlanMutate.mockReset();
    mocks.createRecordMutate.mockReset();
    mocks.deletePlanMutateAsync.mockReset();
    mocks.restorePlanMutateAsync.mockReset();
    mocks.canUseProduct = true;
    mocks.onCreateTimeOverlap = undefined;
    mocks.onUpdateTimeOverlap = undefined;
    mocks.cachedPlans = [];
    mocks.cachedRecords = [];
    mocks.flushSave.mockResolvedValue(undefined);
  });

  it('削除結果の新しいversionでUndo復元する', async () => {
    const deleted = {
      ...futurePlan,
      deleted_at: '2026-07-15T12:00:00.000Z',
      updated_at: '2026-07-15T12:00:00.123456Z',
    };
    mocks.deletePlanMutateAsync.mockResolvedValue(deleted);
    mocks.restorePlanMutateAsync.mockResolvedValue({
      ...futurePlan,
      updated_at: deleted.updated_at,
    });
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await act(async () => undefined);

    expect(mocks.deletePlanMutateAsync).toHaveBeenCalledWith({
      id: futurePlan.id,
      expectedUpdatedAt: futurePlan.updated_at,
    });
    const toastOptions = mocks.toastSuccess.mock.calls.find(
      (call) => call[0] === 'timeblock.editor.toast.deleted',
    )?.[1] as { action?: { onClick: () => void } } | undefined;
    expect(toastOptions?.action).toBeDefined();

    toastOptions?.action?.onClick();
    await act(async () => undefined);
    expect(mocks.restorePlanMutateAsync).toHaveBeenCalledWith({
      id: futurePlan.id,
      expectedUpdatedAt: deleted.updated_at,
    });
  });

  it('利用終了後は編集をflushせず既存versionで削除する', async () => {
    mocks.canUseProduct = false;
    mocks.deletePlanMutateAsync.mockResolvedValue({
      ...futurePlan,
      deleted_at: '2026-07-15T12:00:00.000Z',
    });
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await act(async () => undefined);

    expect(mocks.flushSave).not.toHaveBeenCalled();
    expect(mocks.deletePlanMutateAsync).toHaveBeenCalledWith({
      id: futurePlan.id,
      expectedUpdatedAt: futurePlan.updated_at,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('timeblock.editor.toast.deleted', undefined);
  });

  it('削除直前の保存で期限切れになっても既存versionで削除を続ける', async () => {
    const accessEnded = Object.assign(new Error('Product access has ended'), {
      data: { serviceCode: 'BILLING_ACCESS_ENDED' },
    });
    mocks.flushSave.mockRejectedValueOnce(accessEnded);
    mocks.deletePlanMutateAsync.mockResolvedValue({
      ...futurePlan,
      deleted_at: '2026-07-15T12:00:00.000Z',
    });
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await act(async () => undefined);

    expect(mocks.flushSave).toHaveBeenCalledOnce();
    expect(mocks.deletePlanMutateAsync).toHaveBeenCalledWith({
      id: futurePlan.id,
      expectedUpdatedAt: futurePlan.updated_at,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('timeblock.editor.toast.deleted', undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('作成時フィードフォワードへ end ルール基準の保存先と draft の長さを渡す', () => {
    const planWithActivity = {
      ...futurePlan,
      activity_id: '00000000-0000-4000-8000-000000000002',
    };
    render(<TimeblockInspectorForm kind="plan" plan={planWithActivity} onDeleted={vi.fn()} />);

    // 13:00-14:00（now は 12:00）→ plan / 60 分
    expect(screen.getByTestId('feedforward-props')).toHaveTextContent(
      `plan/${planWithActivity.activity_id}/60`,
    );
  });

  it('過去 Plan では保存先が record になりフィードフォワードが出ない', () => {
    render(<TimeblockInspectorForm kind="plan" plan={pastPlan} onDeleted={vi.fn()} />);

    // 保存先は kind ではなく end_at で決まる。過去 Plan は時間が凍結されていて
    // 見積もりを直す余地が無いため、component 側が null を返す想定の入力になる。
    expect(screen.getByTestId('feedforward-props')).toHaveTextContent(/^record\//);
  });

  it('未来Planの終了を現在以前へ変更でき、保存キューにも送る', () => {
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);

    expect(screen.getByTestId('current-end')).toHaveTextContent('2026-07-15T14:00:00.000Z');

    fireEvent.click(screen.getByRole('button', { name: 'move-to-now' }));

    expect(screen.getByTestId('current-end')).toHaveTextContent('2026-07-15T12:00:00.000Z');
    expect(mocks.enqueueSave).toHaveBeenCalledWith(
      expect.objectContaining({ end_at: '2026-07-15T12:00:00.000Z' }),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('Planを別のPlanと重なる時間へ変更するとインライン表示し、保存しない', () => {
    mocks.cachedPlans = [
      futurePlan,
      {
        id: 'plan-2',
        start_at: '2026-07-15T15:00:00.000Z',
        end_at: '2026-07-15T16:00:00.000Z',
      },
    ];
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'move-to-future' }));

    expect(screen.getByTestId('date-time-error')).toHaveTextContent(
      'timeblock.errors.planTimeOverlap',
    );
    expect(mocks.enqueueSave).not.toHaveBeenCalled();
  });

  it('Recordを別のRecordと重なる時間へ変更するとインライン表示し、保存しない', () => {
    mocks.cachedRecords = [
      relatedRecord,
      {
        id: 'record-2',
        start_at: '2026-07-15T07:00:00.000Z',
        end_at: '2026-07-15T08:00:00.000Z',
      },
    ];
    render(<TimeblockInspectorForm kind="record" record={relatedRecord} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'move-to-past' }));

    expect(screen.getByTestId('date-time-error')).toHaveTextContent(
      'timeblock.errors.recordTimeOverlap',
    );
    expect(mocks.enqueueSave).not.toHaveBeenCalled();
  });

  it('PlanとRecordの相互重複は許可して保存する', () => {
    mocks.cachedPlans = [futurePlan];
    mocks.cachedRecords = [
      {
        id: 'record-2',
        start_at: '2026-07-15T15:00:00.000Z',
        end_at: '2026-07-15T16:00:00.000Z',
      },
    ];
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'move-to-future' }));

    expect(screen.queryByTestId('date-time-error')).not.toBeInTheDocument();
    expect(mocks.enqueueSave).toHaveBeenCalledWith({
      start_at: '2026-07-15T15:00:00.000Z',
      end_at: '2026-07-15T16:00:00.000Z',
    });
  });

  it('編集中の行自身は重複から除外する', () => {
    mocks.cachedPlans = [
      {
        id: futurePlan.id,
        start_at: '2026-07-15T15:00:00.000Z',
        end_at: '2026-07-15T16:00:00.000Z',
      },
    ];
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'move-to-future' }));

    expect(screen.queryByTestId('date-time-error')).not.toBeInTheDocument();
    expect(mocks.enqueueSave).toHaveBeenCalledOnce();
  });

  it('競合後に空き時間へ変更するとエラーを解除して保存する', () => {
    mocks.cachedPlans = [
      futurePlan,
      {
        id: 'plan-2',
        start_at: '2026-07-15T15:00:00.000Z',
        end_at: '2026-07-15T16:00:00.000Z',
      },
    ];
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'move-to-future' }));
    expect(screen.getByTestId('date-time-error')).toBeInTheDocument();

    mocks.cachedPlans = [futurePlan];
    fireEvent.click(screen.getByRole('button', { name: 'move-to-future' }));

    expect(screen.queryByTestId('date-time-error')).not.toBeInTheDocument();
    expect(mocks.enqueueSave).toHaveBeenCalledWith({
      start_at: '2026-07-15T15:00:00.000Z',
      end_at: '2026-07-15T16:00:00.000Z',
    });
  });

  it('serverが現在の時間変更を重複拒否した場合もインライン表示する', () => {
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'move-to-future' }));

    act(() =>
      mocks.onUpdateTimeOverlap?.({
        id: futurePlan.id,
        data: {
          start_at: '2026-07-15T15:00:00.000Z',
          end_at: '2026-07-15T16:00:00.000Z',
        },
      }),
    );

    expect(screen.getByTestId('date-time-error')).toHaveTextContent(
      'timeblock.errors.planTimeOverlap',
    );
  });

  it('記録前にdebounceを止め、最新のアクティビティとメモをsnapshot保存する', () => {
    render(
      <TimeblockInspectorForm
        kind="plan"
        plan={pastPlan}
        relationships={{ kind: 'plan', status: 'success', records: [], onRetry: vi.fn() }}
        onDeleted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'edit-note' }));
    expect(mocks.enqueueSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'prepare-record' }));

    expect(mocks.flushSave).toHaveBeenCalledWith({
      note: '最新メモ',
      activityId: null,
    });

    act(() => vi.advanceTimersByTime(600));
    expect(mocks.enqueueSave).not.toHaveBeenCalled();
  });

  it('時間帯の記録取得中でも独立した記録操作を表示する', () => {
    const { rerender } = render(
      <TimeblockInspectorForm
        kind="plan"
        plan={pastPlan}
        relationships={{ kind: 'plan', status: 'loading', records: [], onRetry: vi.fn() }}
        onOpenRelationship={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'prepare-record' })).toBeInTheDocument();

    rerender(
      <TimeblockInspectorForm
        kind="plan"
        plan={pastPlan}
        relationships={{ kind: 'plan', status: 'success', records: [], onRetry: vi.fn() }}
        onOpenRelationship={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'prepare-record' })).toBeInTheDocument();
  });

  it('時間帯の記録の有無で予定の記録操作を消さない', () => {
    render(
      <TimeblockInspectorForm
        kind="plan"
        plan={pastPlan}
        relationships={{
          kind: 'plan',
          status: 'success',
          records: [relatedRecord],
          onRetry: vi.fn(),
        }}
        onOpenRelationship={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'prepare-record' })).toBeInTheDocument();
  });

  it('記録成功後のRecord IDをInspector切替へ渡す', () => {
    const onOpenRelationship = vi.fn();
    render(
      <TimeblockInspectorForm
        kind="plan"
        plan={pastPlan}
        relationships={{ kind: 'plan', status: 'success', records: [], onRetry: vi.fn() }}
        onOpenRelationship={onOpenRelationship}
        onDeleted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'complete-record' }));
    expect(onOpenRelationship).toHaveBeenCalledWith('record-created', 'record');
  });

  it('詳細メニューから現在の入力内容を複製下書きへ渡す', () => {
    const onStartDuplicate = vi.fn();
    render(
      <TimeblockInspectorForm
        kind="plan"
        plan={futurePlan}
        onStartDuplicate={onStartDuplicate}
        onDeleted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'edit-note' }));
    fireEvent.click(screen.getByRole('button', { name: 'duplicate' }));

    expect(onStartDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: futurePlan.id,
        kind: 'plan',
        title: futurePlan.title,
        note: '最新メモ',
        startAt: futurePlan.start_at,
        endAt: futurePlan.end_at,
      }),
    );
  });

  it('Plan複製の時間重複をインライン表示し、日時変更後に独立したPlanを作成する', () => {
    const onDuplicateCreated = vi.fn();
    const duplicateDraft = createTimeblockDuplicateDraft({
      sourceId: futurePlan.id,
      kind: 'plan',
      title: futurePlan.title,
      note: futurePlan.note,
      startAt: new Date(futurePlan.start_at),
      endAt: new Date(futurePlan.end_at),
    });
    mocks.createPlanMutate.mockImplementationOnce(() => mocks.onCreateTimeOverlap?.());

    render(
      <TimeblockInspectorForm
        kind="plan"
        duplicateDraft={duplicateDraft}
        onDuplicateCreated={onDuplicateCreated}
        onDeleted={vi.fn()}
      />,
    );

    const createButton = screen.getByRole('button', {
      name: 'timeblock.editor.duplicate.create',
    });
    expect(createButton).toBeEnabled();
    expect(screen.queryByTestId('date-time-error')).not.toBeInTheDocument();

    fireEvent.click(createButton);
    expect(screen.getByTestId('date-time-error')).toHaveTextContent(
      'timeblock.errors.planTimeOverlap',
    );
    expect(createButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'move-to-future' }));
    expect(screen.queryByTestId('date-time-error')).not.toBeInTheDocument();
    expect(createButton).toBeEnabled();

    mocks.createPlanMutate.mockImplementation(
      (_input, options: { onSuccess?: (created: { id: string }) => void }) =>
        options.onSuccess?.({ id: 'plan-copy' }),
    );
    fireEvent.click(createButton);

    expect(mocks.createPlanMutate).toHaveBeenLastCalledWith(
      {
        title: futurePlan.title,
        start_at: '2026-07-15T15:00:00.000Z',
        end_at: '2026-07-15T16:00:00.000Z',
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(onDuplicateCreated).toHaveBeenCalledWith('plan-copy', 'plan');
    expect(mocks.enqueueSave).not.toHaveBeenCalled();
  });

  it('Record複製はplanIdを持たない独立Recordを作成する', () => {
    const onDuplicateCreated = vi.fn();
    const duplicateDraft = createTimeblockDuplicateDraft({
      sourceId: relatedRecord.id,
      kind: 'record',
      title: relatedRecord.title,
      note: relatedRecord.note,
      startAt: new Date(relatedRecord.start_at),
      endAt: new Date(relatedRecord.end_at),
    });
    mocks.createRecordMutate.mockImplementation(
      (_input, options: { onSuccess?: (created: { id: string }) => void }) =>
        options.onSuccess?.({ id: 'record-copy' }),
    );

    render(
      <TimeblockInspectorForm
        kind="record"
        duplicateDraft={duplicateDraft}
        onDuplicateCreated={onDuplicateCreated}
        onDeleted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'move-to-past' }));
    fireEvent.click(screen.getByRole('button', { name: 'timeblock.editor.duplicate.create' }));

    const input = mocks.createRecordMutate.mock.calls[0]?.[0];
    expect(input).toEqual({
      title: relatedRecord.title,
      start_at: '2026-07-15T07:00:00.000Z',
      end_at: '2026-07-15T08:00:00.000Z',
    });
    expect(input).not.toHaveProperty('planId');
    expect(onDuplicateCreated).toHaveBeenCalledWith('record-copy', 'record');
  });

  it('アクティビティ選択一覧へ普段の長さを渡す', () => {
    render(<TimeblockInspectorForm kind="plan" plan={futurePlan} onDeleted={vi.fn()} />);

    expect(screen.getByTestId('activity-median')).toHaveTextContent('45');
  });
});
