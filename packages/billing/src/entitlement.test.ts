import { describe, expect, it } from 'vitest';

import { canUseEntitlement, entitlementKeys } from './entitlement';

const allKeys = Object.values(entitlementKeys);

describe('canUseEntitlement', () => {
  it.each(allKeys)('free は %s を持たない', (key) => {
    expect(canUseEntitlement('free', key)).toBe(false);
  });

  it.each(allKeys)('pro は %s を持つ', (key) => {
    expect(canUseEntitlement('pro', key)).toBe(true);
  });
});
