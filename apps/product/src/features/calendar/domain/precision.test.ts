import { describe, expect, it } from 'vitest';

import {
  crossedHapticBoundary,
  DEFAULT_DRAG_SNAP_MINUTES,
  HAPTIC_BOUNDARY_MINUTES,
  INSPECTOR_TIME_PRECISION_MINUTES,
  MIN_TIMEBLOCK_DURATION_MINUTES,
} from './precision';

describe('precision policy constants', () => {
  it('Inspector の精度は 1 分で固定（policy 変更を test で検出する）', () => {
    expect(INSPECTOR_TIME_PRECISION_MINUTES).toBe(1);
  });

  it('drag / resize / tap の snap は 15 分', () => {
    expect(DEFAULT_DRAG_SNAP_MINUTES).toBe(15);
  });

  it('drag と Inspector は非対称（ドラッグの方が粗い）', () => {
    expect(DEFAULT_DRAG_SNAP_MINUTES).toBeGreaterThan(INSPECTOR_TIME_PRECISION_MINUTES);
  });

  it('最小ブロック長は 5 分（snap 粒度とは独立）', () => {
    expect(MIN_TIMEBLOCK_DURATION_MINUTES).toBe(5);
  });

  it('ハプティック境界は 5 分', () => {
    expect(HAPTIC_BOUNDARY_MINUTES).toBe(5);
  });
});

describe('crossedHapticBoundary', () => {
  it('同じ位置では発火しない', () => {
    expect(crossedHapticBoundary(600, 600)).toBe(false);
  });

  it('同一 5 分区画内の移動では発火しない（601 → 604）', () => {
    expect(crossedHapticBoundary(601, 604)).toBe(false);
  });

  it('5 分境界を跨ぐと発火する（604 → 605）', () => {
    expect(crossedHapticBoundary(604, 605)).toBe(true);
  });

  it('下方向へ境界を跨いでも発火する（605 → 604）', () => {
    expect(crossedHapticBoundary(605, 604)).toBe(true);
  });

  it('複数境界をまたぐ大きな移動でも発火する（600 → 630）', () => {
    expect(crossedHapticBoundary(600, 630)).toBe(true);
  });
});
