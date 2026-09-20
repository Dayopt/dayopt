import { beforeEach, describe, expect, it } from 'vitest';

import {
  REPORT_DETAIL_PANEL_DEFAULT_WIDTH,
  REPORT_DETAIL_PANEL_MAX_WIDTH,
  REPORT_DETAIL_PANEL_MIN_WIDTH,
} from '../lib/report-detail-slot';

import { sanitizeReportDetailPersistedState, useReportDetailStore } from './useReportDetailStore';

const WRITE = { activityId: 'act-write', name: '執筆', categoryName: '仕事', color: 'blue' };
const READ = { activityId: 'act-read', name: '読書', categoryName: '学習', color: 'green' };
const UNASSIGNED = { activityId: null, name: null, categoryName: null, color: null };

describe('useReportDetailStore', () => {
  beforeEach(() => {
    useReportDetailStore.getState().close();
    useReportDetailStore.setState({ width: REPORT_DETAIL_PANEL_DEFAULT_WIDTH, isResizing: false });
  });

  it('既定では閉じている', () => {
    expect(useReportDetailStore.getState().isOpen).toBe(false);
    expect(useReportDetailStore.getState().target).toBeNull();
  });

  it('同じ対象を再度選ぶと閉じる', () => {
    useReportDetailStore.getState().toggle(WRITE);
    expect(useReportDetailStore.getState().isOpen).toBe(true);

    useReportDetailStore.getState().toggle(WRITE);
    expect(useReportDetailStore.getState().isOpen).toBe(false);
    expect(useReportDetailStore.getState().target).toBeNull();
  });

  it('別の対象を選ぶと中身が差し替わる（閉じない）', () => {
    useReportDetailStore.getState().toggle(WRITE);
    useReportDetailStore.getState().toggle(READ);

    expect(useReportDetailStore.getState().isOpen).toBe(true);
    expect(useReportDetailStore.getState().target?.activityId).toBe('act-read');
  });

  /**
   * アクティビティ未設定の行は `activityId` が `null`。閉じている状態の `target: null` と
   * 混同すると、開いた直後にもう一度押しても閉じない（または開かない）。
   */
  it('アクティビティ未設定の行も開閉できる', () => {
    useReportDetailStore.getState().toggle(UNASSIGNED);
    expect(useReportDetailStore.getState().isOpen).toBe(true);
    expect(useReportDetailStore.getState().target).toEqual(UNASSIGNED);

    useReportDetailStore.getState().toggle(UNASSIGNED);
    expect(useReportDetailStore.getState().isOpen).toBe(false);
  });

  it('close は対象ごと捨てる', () => {
    useReportDetailStore.getState().toggle(WRITE);
    useReportDetailStore.getState().close();

    expect(useReportDetailStore.getState().isOpen).toBe(false);
    expect(useReportDetailStore.getState().target).toBeNull();
  });

  it('幅の既定は 360 で、ドラッグ中フラグは寝ている', () => {
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_DEFAULT_WIDTH);
    expect(useReportDetailStore.getState().isResizing).toBe(false);
  });

  it('setWidth は上限・下限へ収める', () => {
    useReportDetailStore.getState().setWidth(10);
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_MIN_WIDTH);

    useReportDetailStore.getState().setWidth(9999);
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_MAX_WIDTH);

    useReportDetailStore.getState().setWidth(412.4);
    expect(useReportDetailStore.getState().width).toBe(412);
  });

  it('close は幅を巻き戻さない', () => {
    useReportDetailStore.getState().setWidth(480);
    useReportDetailStore.getState().toggle(WRITE);
    useReportDetailStore.getState().close();

    expect(useReportDetailStore.getState().width).toBe(480);
  });
});

/**
 * localStorage は他バージョン・拡張・手編集で壊れうる。0px や画面幅いっぱいで開くと
 * パネルを掴み直せなくなるので、読み戻す値は必ずここを通す。
 */
describe('sanitizeReportDetailPersistedState', () => {
  it('壊れた値は既定の幅へ倒す', () => {
    expect(sanitizeReportDetailPersistedState(null)).toEqual({
      width: REPORT_DETAIL_PANEL_DEFAULT_WIDTH,
    });
    expect(sanitizeReportDetailPersistedState({ width: '360' })).toEqual({
      width: REPORT_DETAIL_PANEL_DEFAULT_WIDTH,
    });
    expect(sanitizeReportDetailPersistedState({ width: Number.NaN })).toEqual({
      width: REPORT_DETAIL_PANEL_DEFAULT_WIDTH,
    });
  });

  it('範囲外の幅は clamp して受け入れる', () => {
    expect(sanitizeReportDetailPersistedState({ width: 0 })).toEqual({
      width: REPORT_DETAIL_PANEL_MIN_WIDTH,
    });
    expect(sanitizeReportDetailPersistedState({ width: 5000 })).toEqual({
      width: REPORT_DETAIL_PANEL_MAX_WIDTH,
    });
    expect(sanitizeReportDetailPersistedState({ width: 420 })).toEqual({ width: 420 });
  });

  it('開閉と対象は永続化の形に含めない', () => {
    expect(sanitizeReportDetailPersistedState({ width: 420, isOpen: true, target: WRITE })).toEqual(
      { width: 420 },
    );
  });
});
