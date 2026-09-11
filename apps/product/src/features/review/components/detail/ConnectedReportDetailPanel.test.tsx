import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (state: { timezone: string }) => unknown) =>
    selector({ timezone: 'Asia/Tokyo' }),
}));

const useReportActivityDetail = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined, isPending: true, isError: false })),
);

vi.mock('../../hooks/useReportActivityDetail', () => ({ useReportActivityDetail }));

vi.mock('./ReportDetailPanel', () => ({
  ReportDetailPanel: () => <div data-testid="detail-panel" />,
}));

vi.mock('./ReportDetailSheet', () => ({
  ReportDetailSheet: () => <div data-testid="detail-sheet" />,
}));

import { useReportDetailStore } from '../../stores/useReportDetailStore';
import { ConnectedReportDetailPanel } from './ConnectedReportDetailPanel';

const TARGET = { activityId: 'act-1', name: '執筆', categoryName: '仕事', color: 'blue' };

function renderConnected(surface: 'panel' | 'sheet' = 'panel') {
  return render(
    <ConnectedReportDetailPanel anchorDate="2026-09-04" granularity="week" surface={surface} />,
  );
}

describe('ConnectedReportDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useReportDetailStore.getState().close();
  });

  it('閉じている間は何も描かず、明細も取りに行かない', () => {
    const { queryByTestId } = renderConnected();

    expect(queryByTestId('detail-panel')).toBeNull();
    expect(useReportActivityDetail).not.toHaveBeenCalled();
  });

  it('開いていればデスクトップはパネルを描き、推移も取りに行く', () => {
    const { queryByTestId } = renderConnected();

    act(() => useReportDetailStore.getState().toggle(TARGET));

    expect(queryByTestId('detail-panel')).not.toBeNull();
    expect(useReportActivityDetail).toHaveBeenCalledWith(
      expect.objectContaining({ includeTrend: true }),
    );
  });

  /**
   * モバイルは面が狭いのでシートに推移を出さない（仕様 §8）。表示側だけで落とすと
   * 運ぶだけ無駄になるので、**取得ごと** `includeTrend: false` で落とす。
   */
  it('モバイルはシートを描き、推移を取りに行かない', () => {
    const { queryByTestId } = renderConnected('sheet');

    act(() => useReportDetailStore.getState().toggle(TARGET));

    expect(queryByTestId('detail-sheet')).not.toBeNull();
    expect(queryByTestId('detail-panel')).toBeNull();
    expect(useReportActivityDetail).toHaveBeenCalledWith(
      expect.objectContaining({ includeTrend: false }),
    );
  });

  /**
   * store は shell の 4 カラム目の開閉も握っているので、開いたまま `/report` を離れると
   * 中身の無い 250px の帯がカレンダー側に残る。
   */
  it('unmount 時に閉じる（他ページへ帯を持ち越さない）', () => {
    const { unmount } = renderConnected();

    act(() => useReportDetailStore.getState().toggle(TARGET));
    expect(useReportDetailStore.getState().isOpen).toBe(true);

    unmount();

    expect(useReportDetailStore.getState().isOpen).toBe(false);
    expect(useReportDetailStore.getState().target).toBeNull();
  });
});
