import { describe, expect, it } from 'vitest';

import { connectFlowStateSchema } from './google';

const BASE_FLOW = {
  state: 'state-value',
  verifier: 'verifier-value',
  attemptId: '00000000-0000-4000-8000-0000000000a2',
  locale: 'ja',
  userId: '00000000-0000-4000-8000-0000000000a1',
};

describe('connectFlowStateSchema', () => {
  it('server-side attempt ID を含む connect cookie を受け入れる', () => {
    expect(connectFlowStateSchema.safeParse(BASE_FLOW).success).toBe(true);
  });

  it('UUID の reconnectConnectionId を任意で受け入れる', () => {
    expect(
      connectFlowStateSchema.safeParse({
        ...BASE_FLOW,
        reconnectConnectionId: '00000000-0000-4000-8000-0000000000c1',
      }).success,
    ).toBe(true);
    expect(
      connectFlowStateSchema.safeParse({ ...BASE_FLOW, reconnectConnectionId: 'not-a-uuid' })
        .success,
    ).toBe(false);
  });
});
