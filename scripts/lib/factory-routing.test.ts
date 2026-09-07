import { describe, expect, it } from 'vitest';

import { resolveFactoryRoute } from './factory-routing.mjs';

const normal = {
  files: ['scripts/tasks/ctx.mjs'],
  labels: [],
  body: '',
  acceptance: true,
  verification: true,
  metadataAvailable: true,
  state: 'OPEN',
};

describe('factory routing', () => {
  it('通常実装と L1 の事前整理を別々に提示する', () => {
    expect(resolveFactoryRoute(normal)).toMatchObject({
      level: 'L2',
      preparation: 'L1',
      ready: true,
      advisory: true,
    });
  });

  it.each([
    { files: [] },
    { files: null },
    { acceptance: false },
    { verification: false },
    { metadataAvailable: false },
    { state: 'CLOSED' },
    { labels: ['status:blocked'] },
  ])('情報不足・凍結を軽作業に格下げしない: %j', (change) => {
    expect(resolveFactoryRoute({ ...normal, ...change })).toMatchObject({
      level: 'unclassified',
      ready: false,
    });
  });

  it.each([
    'supabase/migrations/20260908000000_change.sql',
    'apps/product/src/features/auth/check.ts',
    './apps/product/src/features/auth/',
    'apps/product/src/features/calendar/drag.ts',
    'apps/product/src/features/timeblock/service.ts',
    'apps/product/src/lib/time/overlap.ts',
    'apps/product/src/lib/time',
  ])('権限・時間規則を L3 候補にする: %s', (path) => {
    expect(resolveFactoryRoute({ ...normal, files: [path] }).level).toBe('L3');
  });

  it('対象が未判明でも危険な手掛かりを消さない', () => {
    expect(resolveFactoryRoute({ ...normal, files: [], body: 'RLS の境界を調査' })).toMatchObject({
      level: 'L3',
      ready: false,
      preparation: 'L0',
    });
  });

  it('review:full は人間向けの印で機械判定に使わない', () => {
    expect(resolveFactoryRoute({ ...normal, labels: ['review:full'] }).level).toBe('L2');
    expect(resolveFactoryRoute({ ...normal, labels: ['type:spike'] }).level).toBe('L3');
  });
});
