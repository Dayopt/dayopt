import { beforeEach, describe, expect, it } from 'vitest';

import { createTimeblockDuplicateDraft } from '../lib/timeblock-duplicate';
import { useTimeblockInspectorStore } from './useTimeblockInspectorStore';

const draft = createTimeblockDuplicateDraft({
  sourceId: 'record-1',
  kind: 'record',
  title: 'Reading',
  note: null,
  startAt: new Date('2026-07-15T09:00:00.000Z'),
  endAt: new Date('2026-07-15T10:00:00.000Z'),
});

describe('useTimeblockInspectorStore duplicate', () => {
  beforeEach(() => {
    useTimeblockInspectorStore.getState().closeInspector();
  });

  it('元ブロックを参照したまま複製下書きを開く', () => {
    useTimeblockInspectorStore.getState().openDuplicate(draft);

    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      isOpen: true,
      timeblockId: 'record-1',
      timeblockKind: 'record',
      duplicateDraft: draft,
    });
  });

  it('キャンセル時は元ブロックの詳細へ戻る', () => {
    useTimeblockInspectorStore.getState().openDuplicate(draft);
    useTimeblockInspectorStore.getState().cancelDuplicate();

    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      isOpen: true,
      timeblockId: 'record-1',
      timeblockKind: 'record',
      duplicateDraft: null,
    });
  });

  it('通常の詳細を開くと複製下書きを破棄する', () => {
    useTimeblockInspectorStore.getState().openDuplicate(draft);
    useTimeblockInspectorStore.getState().openInspector('plan-2', 'plan');

    expect(useTimeblockInspectorStore.getState()).toMatchObject({
      timeblockId: 'plan-2',
      timeblockKind: 'plan',
      duplicateDraft: null,
    });
  });
});

describe('useTimeblockInspectorStore hoveredActivity', () => {
  beforeEach(() => {
    useTimeblockInspectorStore.getState().closeInspector();
  });

  it('setHoveredActivity で値を反映する', () => {
    useTimeblockInspectorStore.getState().openInspector('plan-1', 'plan');
    useTimeblockInspectorStore
      .getState()
      .setHoveredActivity({ id: 'a1', name: '開発', color: 'blue', icon: 'briefcase' });

    expect(useTimeblockInspectorStore.getState().hoveredActivity).toEqual({
      id: 'a1',
      name: '開発',
      color: 'blue',
      icon: 'briefcase',
    });
  });

  it('openInspector / openCreate / openDuplicate / closeInspector はホバーを持ち越さない', () => {
    const setHover = () =>
      useTimeblockInspectorStore
        .getState()
        .setHoveredActivity({ id: 'a1', name: '開発', color: 'blue', icon: null });

    setHover();
    useTimeblockInspectorStore.getState().openInspector('plan-2', 'plan');
    expect(useTimeblockInspectorStore.getState().hoveredActivity).toBeNull();

    setHover();
    useTimeblockInspectorStore.getState().openCreate();
    expect(useTimeblockInspectorStore.getState().hoveredActivity).toBeNull();

    setHover();
    useTimeblockInspectorStore.getState().openDuplicate(draft);
    expect(useTimeblockInspectorStore.getState().hoveredActivity).toBeNull();

    setHover();
    useTimeblockInspectorStore.getState().closeInspector();
    expect(useTimeblockInspectorStore.getState().hoveredActivity).toBeNull();
  });
});
