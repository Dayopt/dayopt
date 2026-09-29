import { describe, expect, it } from 'vitest';

import { isPaidPlan } from './plans';

describe('plan classification', () => {
  it('recognizes pro as paid', () => {
    // 守ること: Pro のプラン識別を失わない。
    expect(isPaidPlan('pro')).toBe(true);
  });

  it('does not treat free as paid', () => {
    // 守ること: 無料プランに有料扱いを与えない。
    expect(isPaidPlan('free')).toBe(false);
  });
});
