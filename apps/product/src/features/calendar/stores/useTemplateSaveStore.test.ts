import { beforeEach, describe, expect, it } from 'vitest';

import { useTemplateSaveStore } from './useTemplateSaveStore';

describe('useTemplateSaveStore', () => {
  beforeEach(() => {
    useTemplateSaveStore.getState().stopSaving();
  });

  it('保存対象の日を持ち、止めると null に戻る', () => {
    useTemplateSaveStore.getState().startSaving('2026-09-14');
    expect(useTemplateSaveStore.getState().savingDateKey).toBe('2026-09-14');

    useTemplateSaveStore.getState().stopSaving();
    expect(useTemplateSaveStore.getState().savingDateKey).toBeNull();
  });

  it('別の日で始め直すと上書きする', () => {
    useTemplateSaveStore.getState().startSaving('2026-09-14');
    useTemplateSaveStore.getState().startSaving('2026-09-15');
    expect(useTemplateSaveStore.getState().savingDateKey).toBe('2026-09-15');
  });
});
