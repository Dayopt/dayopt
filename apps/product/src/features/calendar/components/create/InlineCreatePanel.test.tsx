/**
 * ドラッグ作成パネル（Inspector 作成モード）の挙動。
 *
 * 既定は end_at 判定のまま、過去スロットだけ Plan へ切り替えられること、未来スロットでは
 * 記録タブが選べないことを、実際に呼ばれる作成 mutation まで含めて確認する。
 * また「アクティビティを選んだ瞬間に保存」「閉じたら保存しない」も併せて見る。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInlineCreateStore } from '../../stores/useInlineCreateStore';

import { InlineCreatePanel } from './InlineCreatePanel';

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

  return {
    resolveTimeblockDestination: domain.resolveTimeblockDestination,
    resolveTimeblockKindChoice: domain.resolveTimeblockKindChoice,
    collectTimeblockLaneItems: () => laneItems,
    hasTimeblockLaneConflict: () => false,
    useTimeblockWriteMutations: () => ({
      createPlan: { mutate: createPlanMutate },
      createRecord: { mutate: createRecordMutate },
    }),
    useTimeblockInspectorStore: Object.assign(
      (selector: (s: { openInspector: unknown; closeInspector: unknown }) => unknown) =>
        selector({ openInspector, closeInspector }),
      { getState: () => ({ openInspector, closeInspector }) },
    ),
    // 日付・時間・充実度・メモの入力は TimeblockEditor 側で検証済みなので、
    // ここではメモと充実度が作成入力へ載るかだけを見る
    TimeblockEditor: ({
      onNoteChange,
      fulfillmentSlot,
    }: {
      onNoteChange: (note: string) => void;
      fulfillmentSlot?: React.ReactNode;
    }) => (
      <div>
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
      medianByActivityId: new Map([['activity-1', 45]]),
      getMedianMinutes: (activityId: string | null) => (activityId === 'activity-1' ? 45 : null),
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
  useCreateActivity: () => ({ mutateAsync: vi.fn() }),
  ActivityPickerList: ({
    onSelect,
    onActivityHover,
    durationByActivityId,
  }: {
    onSelect: (id: string, name: string) => void;
    onActivityHover?: (
      activity: { id: string; name: string; color: string | null; icon: string | null } | null,
    ) => void;
    durationByActivityId?: ReadonlyMap<string, number> | undefined;
  }) => (
    <div>
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
      <span data-testid="median">{durationByActivityId?.get('activity-1') ?? 'none'}</span>
    </div>
  ),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (s: { timezone: string; timeFormat: string }) => unknown) =>
    selector({ timezone: 'UTC', timeFormat: '24h' }),
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
    createPlanMutate.mockClear();
    createRecordMutate.mockClear();
    openInspector.mockClear();
    closeInspector.mockClear();
    useInlineCreateStore.getState().clearPendingSelection();
    laneItems.length = 0;
  });

  it('過去スロットの既定は記録で、アクティビティを押した時点で Record を作る', () => {
    setSelection(pastDay());
    render(<InlineCreatePanel onClose={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'timeblock.preview.record' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '開発' }));

    expect(createRecordMutate).toHaveBeenCalledTimes(1);
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
