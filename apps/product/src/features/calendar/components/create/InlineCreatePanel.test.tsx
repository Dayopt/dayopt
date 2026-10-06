/**
 * ドラッグ作成パネル（Inspector 作成モード）の挙動。
 *
 * 既定は end_at 判定のまま、過去スロットだけ Plan へ切り替えられること、未来スロットでは
 * 記録タブが選べないことを、実際に呼ばれる作成 mutation まで含めて確認する。
 * また「アクティビティを選んだ瞬間に保存」「閉じたら保存しない」も併せて見る。
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimeModelEditorValue } from '@/features/timeblock';

import { useInlineCreateStore } from '../../stores/useInlineCreateStore';

import { InlineCreatePanel } from './InlineCreatePanel';

const preferences = vi.hoisted(() => ({ timezone: 'UTC', timeFormat: '24h' }));
const statsPending = vi.hoisted(() => ({ value: false }));
const resolveMedianMinutes = vi.hoisted(() => vi.fn());
const createActivityMutateAsync = vi.hoisted(() => vi.fn());
const medians = vi.hoisted(() => new Map<string, number>([['activity-1', 45]]));

const createPlanMutate = vi.hoisted(() => vi.fn());
const createRecordMutate = vi.hoisted(() => vi.fn());
const openInspector = vi.hoisted(() => vi.fn());
const closeInspector = vi.hoisted(() => vi.fn());
/** plans.list cache の代役。残り時間の計算対象（#2096） */
const laneItems = vi.hoisted(() => [] as { id: string; start_at: string; end_at: string }[]);

vi.mock('@/features/timeblock', async () => {
  const domain = await vi.importActual<
    typeof import('@/features/timeblock/domain/timeblock-destination')
  >('@/features/timeblock/domain/timeblock-destination');
  const laneConflict = await vi.importActual<
    typeof import('@/features/timeblock/lib/timeblock-lane-conflict')
  >('@/features/timeblock/lib/timeblock-lane-conflict');

  return {
    resolveTimeblockDestination: domain.resolveTimeblockDestination,
    resolveTimeblockKindChoice: domain.resolveTimeblockKindChoice,
    collectTimeblockLaneItems: () => laneItems,
    hasTimeblockLaneConflict: laneConflict.hasTimeblockLaneConflict,
    useTimeblockWriteMutations: () => ({
      createPlan: { mutate: createPlanMutate },
      createRecord: { mutate: createRecordMutate },
    }),
    useTimeblockInspectorStore: Object.assign(
      (selector: (s: { openInspector: unknown; closeInspector: unknown }) => unknown) =>
        selector({ openInspector, closeInspector }),
      { getState: () => ({ openInspector, closeInspector }) },
    ),
    // Editor境界の実時刻と、作成入力への受け渡しを検証する。
    TimeblockEditor: ({
      value,
      onDateTimeChange,
      onNoteChange,
      fulfillmentSlot,
    }: {
      value: TimeModelEditorValue;
      onDateTimeChange: (next: TimeModelEditorValue) => void;
      onNoteChange: (note: string) => void;
      fulfillmentSlot?: React.ReactNode;
    }) => (
      <div>
        <output data-testid="editor-start-instant">{value.startAt.toISOString()}</output>
        <output data-testid="editor-end-instant">{value.endAt.toISOString()}</output>
        <button
          type="button"
          onClick={() =>
            onDateTimeChange({
              ...value,
              startAt: new Date('2026-09-29T16:30:00Z'),
              endAt: new Date('2026-09-29T17:30:00Z'),
            })
          }
        >
          edit-time
        </button>
        <button
          type="button"
          onClick={() => onDateTimeChange({ ...value, startAt: new Date('2026-09-29T16:30:00Z') })}
        >
          edit-start
        </button>
        <button type="button" onClick={() => onNoteChange('集中できた')}>
          note
        </button>
        {fulfillmentSlot}
      </div>
    ),
    RecordFulfillmentRow: ({ onChange }: { onChange: (v: 'low' | 'medium' | 'high') => void }) => (
      <button type="button" onClick={() => onChange('high')}>
        fulfillment
      </button>
    ),
    useActivityMedianDurations: () => ({
      medianByActivityId: medians,
      isPending: statsPending.value,
      resolveMedianMinutes,
      getMedianMinutes: (activityId: string | null) =>
        activityId === null ? null : (medians.get(activityId) ?? null),
    }),
    InspectorHeaderActions: ({ onCloseInspector }: { onCloseInspector?: () => void }) => (
      <button type="button" onClick={onCloseInspector}>
        close
      </button>
    ),
  };
});

// アクティビティ一覧は 1 件だけ返す。押すとその場で作成へ進む。
// 受け取った中央値は行の表示へ回すので、ここでは「渡ってきたか」だけを見える形にする
// （pill の描画そのものは ActivityQuickSelector.test.tsx が実物で確認する）
vi.mock('@/features/activities', () => ({
  useCreateActivity: () => ({ mutateAsync: createActivityMutateAsync }),
  ActivityPickerList: ({
    onSelect,
    onCreateAndSelect,
    onActivityHover,
    durationByActivityId,
  }: {
    onSelect: (id: string, name: string) => void;
    onCreateAndSelect: (name: string) => void;
    onActivityHover?: (
      activity: { id: string; name: string; color: string | null; icon: string | null } | null,
    ) => void;
    durationByActivityId?: ReadonlyMap<string, number> | undefined;
  }) => (
    <div>
      <button type="button" onClick={() => onCreateAndSelect('新規活動')}>
        新規活動を作成
      </button>
      <button
        type="button"
        onClick={() => onSelect('activity-1', '開発')}
        onMouseEnter={() =>
          onActivityHover?.({ id: 'activity-1', name: '開発', color: 'blue', icon: 'briefcase' })
        }
        onMouseLeave={() => onActivityHover?.(null)}
      >
        開発
      </button>
      <button type="button" onClick={() => onSelect('activity-2', '読書')}>
        読書
      </button>
      <span data-testid="median">{durationByActivityId?.get('activity-1') ?? 'none'}</span>
    </div>
  ),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (s: { timezone: string; timeFormat: string }) => unknown) =>
    selector(preferences),
}));
vi.mock('../../hooks/accessibility/useHapticFeedback', () => ({
  useHapticFeedback: () => ({ tap: vi.fn(), impact: vi.fn() }),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'ja',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

/** 指定日の 9:00-10:00 を pendingSelection に置く */
function setSelection(date: Date) {
  // ドラッグ確定と同じ経路を通す。ここで「ドラッグで決めた長さ」が記録され、
  // ホバーを外した時の戻り先になる
  useInlineCreateStore.getState().setPendingSelection({
    date,
    startHour: 9,
    startMinute: 0,
    endHour: 10,
    endMinute: 0,
  });
}

function pastDay() {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return d;
}

function futureDay() {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d;
}

describe('InlineCreatePanel', () => {
  beforeEach(() => {
    preferences.timezone = 'UTC';
    createPlanMutate.mockClear();
    createRecordMutate.mockClear();
    openInspector.mockClear();
    closeInspector.mockClear();
    useInlineCreateStore.getState().clearPendingSelection();
    laneItems.length = 0;
    statsPending.value = false;
    resolveMedianMinutes.mockReset();
    createActivityMutateAsync.mockReset();
    createActivityMutateAsync.mockResolvedValue({ id: 'activity-new' });
  });

  it('未編集のクリック選択は統計を待ち中央値で一度だけ保存する', async () => {
    statsPending.value = true;
    let release!: (value: number | null) => void;
    resolveMedianMinutes.mockReturnValue(
      new Promise<number | null>((resolve) => {
        release = resolve;
      }),
    );
    setSelection(futureDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    expect(createPlanMutate).not.toHaveBeenCalled();
    await act(async () => {
      release(45);
    });
    expect(createPlanMutate).toHaveBeenCalledTimes(1);
    const input = createPlanMutate.mock.calls[0]?.[0];
    expect((Date.parse(input.end_at) - Date.parse(input.start_at)) / 60000).toBe(45);
  });

  it('中央値待ちに閉じた選択は保存せず、新しい選択にも保存しない', async () => {
    statsPending.value = true;
    let release!: (value: number | null) => void;
    resolveMedianMinutes.mockReturnValue(
      new Promise<number | null>((resolve) => {
        release = resolve;
      }),
    );
    setSelection(futureDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    act(() => {
      useInlineCreateStore.getState().clearPendingSelection();
      setSelection(pastDay());
    });
    await act(async () => {
      release(45);
    });
    expect(createPlanMutate).not.toHaveBeenCalled();
    expect(createRecordMutate).not.toHaveBeenCalled();
  });

  it('待機中の選択を閉じても次の選択の作成要求を捨てない', async () => {
    statsPending.value = true;
    let release!: (value: number | null) => void;
    resolveMedianMinutes.mockReturnValue(
      new Promise<number | null>((resolve) => {
        release = resolve;
      }),
    );
    setSelection(futureDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    act(() => {
      useInlineCreateStore.getState().clearPendingSelection();
      setSelection(pastDay());
    });
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    await act(async () => {
      release(45);
    });
    expect(createPlanMutate).not.toHaveBeenCalled();
    expect(createRecordMutate).toHaveBeenCalledTimes(1);
  });

  it('新規活動の中央値待ちを選択差替えで解除し、次の選択を作成できる', async () => {
    statsPending.value = true;
    const releases: ((value: number | null) => void)[] = [];
    resolveMedianMinutes.mockImplementation(
      () => new Promise<number | null>((resolve) => releases.push(resolve)),
    );
    setSelection(futureDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '新規活動を作成' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolveMedianMinutes).toHaveBeenCalledTimes(1);

    act(() => setSelection(pastDay()));
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    expect(resolveMedianMinutes).toHaveBeenCalledTimes(2);

    await act(async () => {
      releases[0]?.(45);
      releases[1]?.(45);
    });
    expect(createPlanMutate).not.toHaveBeenCalled();
    expect(createRecordMutate).toHaveBeenCalledTimes(1);
  });

  it('統計待ちでも明示的に編集した長さは待たず保存する', () => {
    statsPending.value = true;
    setSelection(pastDay());
    act(() => useInlineCreateStore.getState().updateSelectionTimes({ endHour: 11, endMinute: 15 }));
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    expect(resolveMedianMinutes).not.toHaveBeenCalled();
    expect(createRecordMutate).toHaveBeenCalledTimes(1);
    expect(createRecordMutate.mock.calls[0]?.[0].end_at).toContain('T11:15:00');
  });

  it('保存の統計待ち中に編集した時間・メモ・充実度を維持する', async () => {
    statsPending.value = true;
    let release!: (value: number | null) => void;
    resolveMedianMinutes.mockReturnValue(
      new Promise<number | null>((resolve) => {
        release = resolve;
      }),
    );
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    fireEvent.click(screen.getByRole('button', { name: 'fulfillment' }));
    act(() => useInlineCreateStore.getState().updateSelectionTimes({ endHour: 11, endMinute: 15 }));
    await act(async () => {
      release(45);
    });
    expect(createRecordMutate).toHaveBeenCalledTimes(1);
    expect(createRecordMutate.mock.calls[0]?.[0]).toMatchObject({
      note: '集中できた',
      fulfillment: 'high',
      end_at: expect.stringContaining('T11:15:00'),
    });
  });

  it('明示的なdragの長さは統計を待たず維持する', () => {
    statsPending.value = true;
    setSelection(pastDay());
    const selection = useInlineCreateStore.getState().pendingSelection!;
    useInlineCreateStore
      .getState()
      .setPendingSelection({ ...selection, durationSource: 'dragged' });
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    expect(resolveMedianMinutes).not.toHaveBeenCalled();
    const input = createRecordMutate.mock.calls[0]?.[0];
    expect((Date.parse(input.end_at) - Date.parse(input.start_at)) / 60000).toBe(60);
  });

  it('統計待ちに選び直した活動だけを保存する', async () => {
    statsPending.value = true;
    let release!: (value: number | null) => void;
    resolveMedianMinutes.mockReturnValue(
      new Promise<number | null>((resolve) => {
        release = resolve;
      }),
    );
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    fireEvent.click(screen.getByRole('button', { name: '読書' }));
    await act(async () => {
      release(30);
    });
    expect(createRecordMutate).toHaveBeenCalledTimes(1);
    expect(createRecordMutate.mock.calls[0]?.[0]).toMatchObject({
      activityId: 'activity-2',
      title: '読書',
    });
  });

  it('clearを挟まず置換した選択へ古い作成要求を保存しない', async () => {
    statsPending.value = true;
    let release!: (value: number | null) => void;
    resolveMedianMinutes.mockReturnValue(
      new Promise<number | null>((resolve) => {
        release = resolve;
      }),
    );
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    act(() => setSelection(futureDay()));
    await act(async () => {
      release(45);
    });
    expect(createRecordMutate).not.toHaveBeenCalled();
    expect(createPlanMutate).not.toHaveBeenCalled();
  });

  it('late stats keep edited selection and save fields, and do not create again', () => {
    medians.clear();
    setSelection(pastDay());
    const view = render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    fireEvent.click(screen.getByRole('button', { name: 'fulfillment' }));
    act(() => useInlineCreateStore.getState().updateSelectionTimes({ endHour: 11, endMinute: 15 }));
    const selection = useInlineCreateStore.getState().pendingSelection;
    expect(screen.getByTestId('median')).toHaveTextContent('none');
    medians.set('activity-1', 45);
    view.rerender(<InlineCreatePanel onClose={vi.fn()} />);
    expect(screen.getByTestId('median')).toHaveTextContent('45');
    expect(useInlineCreateStore.getState().pendingSelection).toEqual(selection);
    expect(createRecordMutate).not.toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByRole('button', { name: '開発' }));
    expect(useInlineCreateStore.getState().pendingSelection).toEqual(selection);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    expect(createRecordMutate).toHaveBeenCalledTimes(1);
    expect(createRecordMutate.mock.calls[0]?.[0]).toMatchObject({
      note: '集中できた',
      fulfillment: 'high',
      activityId: 'activity-1',
      end_at: expect.stringContaining('T11:15:00'),
    });
    medians.set('activity-1', 90);
    view.rerender(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    expect(createRecordMutate).toHaveBeenCalledTimes(1);
    expect(createPlanMutate).not.toHaveBeenCalled();
    medians.set('activity-1', 45);
  });

  it('ニューヨークの選択日時をEditorへ実時刻で渡す', () => {
    preferences.timezone = 'America/New_York';
    setSelection(new Date(2026, 8, 29));
    render(<InlineCreatePanel onClose={vi.fn()} />);

    expect(screen.getByTestId('editor-start-instant')).toHaveTextContent(
      '2026-09-29T13:00:00.000Z',
    );
    expect(screen.getByTestId('editor-end-instant')).toHaveTextContent('2026-09-29T14:00:00.000Z');
  });

  it('Editorからの実時刻をドラッグ選択日時へ戻して同じ時刻で作成する', () => {
    preferences.timezone = 'America/New_York';
    useInlineCreateStore.getState().setPendingSelection({
      date: new Date(2026, 8, 29),
      startHour: 9,
      startMinute: 0,
      endHour: 10,
      endMinute: 0,
      durationSource: 'dragged',
    });
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'edit-time' }));

    const selection = useInlineCreateStore.getState().pendingSelection;
    expect(selection?.date.getFullYear()).toBe(2026);
    expect(selection?.date.getMonth()).toBe(8);
    expect(selection?.date.getDate()).toBe(29);
    expect(selection).toMatchObject({ startHour: 12, startMinute: 30, endHour: 13, endMinute: 30 });
    fireEvent.click(screen.getByRole('tab', { name: 'timeblock.preview.plan' }));
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    expect(createPlanMutate).toHaveBeenCalledOnce();
    expect(createPlanMutate.mock.calls[0]?.[0]).toMatchObject({
      start_at: '2026-09-29T16:30:00.000Z',
      end_at: '2026-09-29T17:30:00.000Z',
    });
  });

  it('開始だけ編集しても選択日の24時終了を保持する', () => {
    preferences.timezone = 'America/New_York';
    useInlineCreateStore.getState().setPendingSelection({
      date: new Date(2026, 8, 29),
      startHour: 12,
      startMinute: 0,
      endHour: 24,
      endMinute: 0,
      durationSource: 'dragged',
    });
    render(<InlineCreatePanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'edit-start' }));
    expect(useInlineCreateStore.getState().pendingSelection).toMatchObject({
      startHour: 12,
      startMinute: 30,
      endHour: 24,
      endMinute: 0,
    });
    fireEvent.click(screen.getByRole('tab', { name: 'timeblock.preview.plan' }));
    fireEvent.click(screen.getByRole('button', { name: '開発' }));
    expect(createPlanMutate.mock.calls[0]?.[0]).toMatchObject({
      start_at: '2026-09-29T16:30:00.000Z',
      end_at: '2026-09-30T04:00:00.000Z',
    });
  });

  it('過去スロットの既定は記録で、アクティビティを押した時点で Record を作る', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'timeblock.preview.record' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '開発' }));

    expect(createRecordMutate).toHaveBeenCalledTimes(1);
    expect(createPlanMutate).not.toHaveBeenCalled();
  });

  it('明示的なRecord作成は既存Recordと重なる時に作成しない', () => {
    const day = pastDay();
    const start = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 9));
    laneItems.push({
      id: 'record-existing',
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
    });
    setSelection(day);
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '開発' }));

    expect(createRecordMutate).not.toHaveBeenCalled();
    expect(createPlanMutate).not.toHaveBeenCalled();
  });

  it('過去スロットで予定タブへ切り替えると Plan を作る', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'timeblock.preview.plan' }));
    expect(useInlineCreateStore.getState().pendingSelection?.kind).toBe('plan');

    fireEvent.click(screen.getByRole('button', { name: '開発' }));

    expect(createPlanMutate).toHaveBeenCalledTimes(1);
    expect(createRecordMutate).not.toHaveBeenCalled();
  });

  it('未来スロットでは記録タブが選べず、選択すると Plan を作る', () => {
    setSelection(futureDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'timeblock.preview.record' })).toBeDisabled();
    expect(screen.getByText('activitySelector.recordUnavailableFuture')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '開発' }));

    expect(createPlanMutate).toHaveBeenCalledTimes(1);
    expect(createRecordMutate).not.toHaveBeenCalled();
  });

  it('一覧のホバーは store 経由でグリッドのハイライトへ伝わる', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByRole('button', { name: '開発' }));

    // ハイライトは別コンポーネントなので、hook の local state ではなく store を読む
    expect(useInlineCreateStore.getState().hoveredActivity).toMatchObject({
      id: 'activity-1',
      name: '開発',
    });
  });

  it('ホバーするとそのアクティビティの普段の長さが選択範囲へ着る', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByRole('button', { name: '開発' }));

    // 9:00–10:00 のドラッグが、中央値 45 分に合わせて 9:00–9:45 になる。
    // グリッドのハイライトはこの pendingSelection を読んで厚みを描く
    const selection = useInlineCreateStore.getState().pendingSelection;
    expect(selection?.endHour).toBe(9);
    expect(selection?.endMinute).toBe(45);
  });

  it('ホバーを外すとドラッグで決めた長さへ戻る', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);
    const pill = screen.getByRole('button', { name: '開発' });

    fireEvent.mouseEnter(pill);
    fireEvent.mouseLeave(pill);

    const selection = useInlineCreateStore.getState().pendingSelection;
    expect(selection?.endHour).toBe(10);
    expect(selection?.endMinute).toBe(0);
  });

  it('プレビューした長さのまま作成する（表示と保存が食い違わない）', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '開発' }));

    const [input] = createRecordMutate.mock.calls[0] as [{ start_at: string; end_at: string }];
    const durationMinutes =
      (new Date(input.end_at).getTime() - new Date(input.start_at).getTime()) / 60000;
    expect(durationMinutes).toBe(45);
  });

  it('メモと充実度は作成入力へ載る（記録）', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    fireEvent.click(screen.getByRole('button', { name: 'fulfillment' }));
    fireEvent.click(screen.getByRole('button', { name: '開発' }));

    const [input] = createRecordMutate.mock.calls[0] as [{ note?: string; fulfillment?: string }];
    expect(input.note).toBe('集中できた');
    expect(input.fulfillment).toBe('high');
  });

  it('予定では充実度の行を出さず、メモだけ載る', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'timeblock.preview.plan' }));
    expect(screen.queryByRole('button', { name: 'fulfillment' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    fireEvent.click(screen.getByRole('button', { name: '開発' }));

    const [input] = createPlanMutate.mock.calls[0] as [{ note?: string; fulfillment?: string }];
    expect(input.note).toBe('集中できた');
    expect(input.fulfillment).toBeUndefined();
  });

  it('記録の中央値をアクティビティ一覧へ渡す（予定・記録どちらのタブでも）', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    expect(screen.getByTestId('median')).toHaveTextContent('45');
  });

  it('閉じるボタンでは何も作成しない', () => {
    const onClose = vi.fn();
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createPlanMutate).not.toHaveBeenCalled();
    expect(createRecordMutate).not.toHaveBeenCalled();
  });

  describe('その日の残り時間（#2096）', () => {
    /** 壁時計の日付 + 時刻から、mock した TZ（UTC）の instant を作る */
    function utcAt(day: Date, hour: number): string {
      return new Date(
        Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0),
      ).toISOString();
    }

    it('24h から cache 上の予定合計と選択中の長さを引いた残りを出す', () => {
      const day = futureDay();
      laneItems.push({ id: 'p1', start_at: utcAt(day, 13), end_at: utcAt(day, 14) });
      setSelection(day);

      const { container } = render(<InlineCreatePanel onClose={vi.fn()} />);

      // 24h - 予定 1h - 選択 1h = 22h
      const label = container.querySelector('[data-remaining-day-minutes]');
      expect(label).toHaveAttribute('data-remaining-day-minutes', '1320');
      expect(label?.textContent).toContain('22h');
    });

    it('別の日の予定は引かない', () => {
      const day = futureDay();
      const otherDay = new Date(day);
      otherDay.setDate(otherDay.getDate() + 1);
      laneItems.push({ id: 'p1', start_at: utcAt(otherDay, 13), end_at: utcAt(otherDay, 14) });
      setSelection(day);

      const { container } = render(<InlineCreatePanel onClose={vi.fn()} />);

      // 24h - 選択 1h = 23h
      expect(container.querySelector('[data-remaining-day-minutes]')).toHaveAttribute(
        'data-remaining-day-minutes',
        '1380',
      );
    });

    it('記録タブでは出さない（過去スロットの既定）', () => {
      setSelection(pastDay());

      const { container } = render(<InlineCreatePanel onClose={vi.fn()} />);

      expect(container.querySelector('[data-remaining-day-minutes]')).toBeNull();
    });

    it('過去スロットで予定タブへ切り替えると出る', () => {
      setSelection(pastDay());

      const { container } = render(<InlineCreatePanel onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('tab', { name: 'timeblock.preview.plan' }));

      expect(container.querySelector('[data-remaining-day-minutes]')).toHaveAttribute(
        'data-remaining-day-minutes',
        '1380',
      );
    });
  });
});
