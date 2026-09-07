import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Activity } from '@/features/activities';

const mutateMock = vi.hoisted(() => vi.fn());

// 行タップの即作成は useActivityQuickCreate.test / E2E が担う。ここは DnD だけを見るので
// tRPC / user preferences を必要としない no-op に差し替える
vi.mock('./hooks/useActivityQuickCreate', () => ({
  useActivityQuickCreate: () => vi.fn(),
}));

vi.mock('@/features/activities', async () => {
  const actual =
    await vi.importActual<typeof import('@/features/activities')>('@/features/activities');
  return {
    ...actual,
    // 所属変更の書き込みだけ差し替える。楽観的更新の中身は
    // useActivityMutations 側の責務で、ここでは「正しい引数で撃たれたか」を見る
    useUpdateActivity: () => ({ mutate: mutateMock }),
  };
});

import { ActivityDragProvider } from './ActivityDragContext';
import { ActivityRow } from './components/ActivityRow';
import { UncategorizedDropZone } from './components/UncategorizedDropZone';
import { useActivityDropTarget } from './useActivityDragHandlers';

const TIMESTAMPS = {
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const WORK = 'cat-work';
const STUDY = 'cat-study';

function activity(id: string, name: string, categoryId: string | null): Activity {
  return { id, name, user_id: 'user-1', category_id: categoryId, archived_at: null, ...TIMESTAMPS };
}

/** jsdom / happy-dom には DataTransfer のコンストラクタが無いので最小限を手で作る */
function dataTransferStub() {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    effectAllowed: '',
    dropEffect: '',
  };
}

/** 実際の CategoryGroup と同じ hook を使うカテゴリーのドロップ先 */
function CategoryDropTarget({ categoryId }: { categoryId: string }) {
  const { isActiveTarget, dropProps } = useActivityDropTarget(categoryId);
  return (
    <div data-testid={`drop-${categoryId}`} data-active={isActiveTarget} {...dropProps}>
      {categoryId}
    </div>
  );
}

interface HarnessProps {
  /** ドラッグ元の行 */
  source: Activity;
  allActivities: Activity[];
}

function Harness({ source, allActivities }: HarnessProps) {
  return (
    <ActivityDragProvider allActivities={allActivities}>
      <ActivityRow
        activity={source}
        allActivities={allActivities}
        checked
        categoryId={source.category_id}
        categoryOptions={[]}
        isMobile={false}
        onToggle={() => {}}
        onArchiveActivity={() => {}}
        onDeleteActivity={() => {}}
        onShowOnlyActivity={() => {}}
      />
      <CategoryDropTarget categoryId={WORK} />
      <CategoryDropTarget categoryId={STUDY} />
      <UncategorizedDropZone>
        <div data-testid="uncategorized-body" />
      </UncategorizedDropZone>
    </ActivityDragProvider>
  );
}

/** 行の drag source は listitem 直下の div（ActivityRow の実装に合わせる） */
function getRow() {
  return screen.getByRole('listitem').firstElementChild as HTMLElement;
}

function getUncategorizedZone() {
  return screen.getByTestId('uncategorized-body').parentElement as HTMLElement;
}

describe('サイドバーの所属変更 DnD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('カテゴリーの行を未分類へ落とすと categoryId: null で更新する', () => {
    const meeting = activity('act-1', '会議', WORK);
    render(<Harness source={meeting} allActivities={[meeting]} />);

    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(getRow(), { dataTransfer });

    const zone = getUncategorizedZone();
    fireEvent.dragOver(zone, { dataTransfer });
    fireEvent.drop(zone, { dataTransfer });

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith({ id: 'act-1', categoryId: null });
  });

  it('未分類の行をカテゴリーへ落とすとそのカテゴリー ID で更新する', () => {
    const workout = activity('act-1', '運動', null);
    render(<Harness source={workout} allActivities={[workout]} />);

    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(getRow(), { dataTransfer });

    const target = screen.getByTestId(`drop-${STUDY}`);
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(mutateMock).toHaveBeenCalledWith({ id: 'act-1', categoryId: STUDY });
  });

  it('カテゴリー間を移動できる', () => {
    const meeting = activity('act-1', '会議', WORK);
    render(<Harness source={meeting} allActivities={[meeting]} />);

    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(getRow(), { dataTransfer });

    const target = screen.getByTestId(`drop-${STUDY}`);
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(mutateMock).toHaveBeenCalledWith({ id: 'act-1', categoryId: STUDY });
  });

  it('今いるカテゴリーへ落としても何も書き込まない（ハイライトも出ない）', () => {
    const meeting = activity('act-1', '会議', WORK);
    render(<Harness source={meeting} allActivities={[meeting]} />);

    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(getRow(), { dataTransfer });

    const ownCategory = screen.getByTestId(`drop-${WORK}`);
    fireEvent.dragOver(ownCategory, { dataTransfer });
    expect(ownCategory).toHaveAttribute('data-active', 'false');

    fireEvent.drop(ownCategory, { dataTransfer });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('移動先に同名がいる時はハイライトも書き込みも起きない', () => {
    const source = activity('act-1', '会議', WORK);
    const conflict = activity('act-2', '会議', STUDY);
    render(<Harness source={source} allActivities={[source, conflict]} />);

    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(getRow(), { dataTransfer });

    const target = screen.getByTestId(`drop-${STUDY}`);
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveAttribute('data-active', 'false');

    fireEvent.drop(target, { dataTransfer });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('有効なドロップ先に乗るとハイライトが立つ', () => {
    const meeting = activity('act-1', '会議', WORK);
    render(<Harness source={meeting} allActivities={[meeting]} />);

    const dataTransfer = dataTransferStub();
    const target = screen.getByTestId(`drop-${STUDY}`);

    expect(target).toHaveAttribute('data-active', 'false');
    fireEvent.dragStart(getRow(), { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveAttribute('data-active', 'true');
  });

  it('ドラッグしていない時の drop（外部からのファイル等）には反応しない', () => {
    const meeting = activity('act-1', '会議', WORK);
    render(<Harness source={meeting} allActivities={[meeting]} />);

    const dataTransfer = dataTransferStub();
    const target = screen.getByTestId(`drop-${STUDY}`);

    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveAttribute('data-active', 'false');

    fireEvent.drop(target, { dataTransfer });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('行の中のボタンを掴んだ場合はドラッグを開始しない', () => {
    const meeting = activity('act-1', '会議', WORK);
    render(<Harness source={meeting} allActivities={[meeting]} />);

    // 👁（表示切替）ボタン。dragstart の target は draggable な祖先（行）に
    // なるため、mousedown 側で掴んだ場所を覚えていないと弾けない
    const toggleButton = screen.getByRole('button', { name: 'calendar.filter.hide' });
    fireEvent.mouseDown(toggleButton);

    const dataTransfer = dataTransferStub();
    const dragStarted = fireEvent.dragStart(getRow(), { dataTransfer });

    // preventDefault されると fireEvent は false を返す
    expect(dragStarted).toBe(false);

    const target = screen.getByTestId(`drop-${STUDY}`);
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveAttribute('data-active', 'false');
  });

  it('ドラッグ終了でハイライトが必ず畳まれる', () => {
    const meeting = activity('act-1', '会議', WORK);
    render(<Harness source={meeting} allActivities={[meeting]} />);

    const dataTransfer = dataTransferStub();
    const target = screen.getByTestId(`drop-${STUDY}`);

    fireEvent.dragStart(getRow(), { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveAttribute('data-active', 'true');

    // Escape / 枠外へのドロップなど、drop が起きずに終わる経路
    fireEvent.dragEnd(getRow(), { dataTransfer });
    expect(target).toHaveAttribute('data-active', 'false');
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
