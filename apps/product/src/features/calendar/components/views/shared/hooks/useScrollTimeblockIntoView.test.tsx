import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/features/timeblock', () => ({
  useTimeblockInspectorStore: (
    selector: (state: { timeblockId: string; isOpen: boolean }) => unknown,
  ) => selector({ timeblockId: 'selected', isOpen: true }),
}));
vi.mock('../../../../stores/useInlineCreateStore', () => ({
  useInlineCreateStore: { use: { pendingSelection: () => null } },
}));

import { useScrollTimeblockIntoView } from './useScrollTimeblockIntoView';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const container = document.createElement('div');
  container.scrollTo = vi.fn();
  Object.defineProperty(container, 'clientHeight', { value: 400 });
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 500, 400));
  const ref = { current: container };
  renderHook(() => useScrollTimeblockIntoView({ scrollContainerRef: ref, hourHeight: 60 }));
  return container;
}

function addCard(container: HTMLElement, top: number) {
  const card = document.createElement('div');
  card.dataset.entryId = 'selected';
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 100, 60));
  container.append(card);
}

it('データ取得後に遅れて描画された画面外のカードへスクロールする', async () => {
  const container = setup();
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(container.scrollTo).not.toHaveBeenCalled();
  addCard(container, 900);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(container.scrollTo).toHaveBeenCalledWith({ top: 700, behavior: 'smooth' });
});

it('デスクトップで既に見えているカードを開いてもスクロールしない', async () => {
  const container = setup();
  addCard(container, 200);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(container.scrollTo).not.toHaveBeenCalled();
});
