import { beforeEach, describe, expect, it } from 'vitest';

import { useActivityDetailStore } from './useActivityDetailStore';

describe('useActivityDetailStore', () => {
  beforeEach(() => useActivityDetailStore.getState().close());

  it('opens a selected activity and replaces the current selection', () => {
    useActivityDetailStore.getState().open({ activityId: 'a1', name: 'Writing' });
    useActivityDetailStore.getState().open({ activityId: 'a2', name: 'Reading' });

    expect(useActivityDetailStore.getState().isOpen).toBe(true);
    expect(useActivityDetailStore.getState().target).toEqual({ activityId: 'a2', name: 'Reading' });
  });

  it('close clears the transient selection', () => {
    useActivityDetailStore.getState().open({ activityId: 'a1', name: 'Writing' });
    useActivityDetailStore.getState().close();

    expect(useActivityDetailStore.getState().isOpen).toBe(false);
    expect(useActivityDetailStore.getState().target).toBeNull();
  });
});
