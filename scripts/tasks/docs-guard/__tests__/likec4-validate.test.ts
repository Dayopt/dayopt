import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasWatchedChanges,
  LIKEC4_VERSION,
  reportLikeC4ValidateCheck,
} from '../checks/likec4-validate.ts';

describe('likec4-validate: 走らせる条件', () => {
  it('生成器が変わったら走らせる', () => {
    expect(hasWatchedChanges(['scripts/lib/architecture-map/likec4-model.ts'])).toBe(true);
  });

  it('生成物の .c4 が変わったら走らせる', () => {
    expect(hasWatchedChanges(['docs/engineering/data/architecture/model.c4'])).toBe(true);
  });

  it('無関係な変更では走らせない（毎 PR で likec4 を取りに行かないため）', () => {
    expect(
      hasWatchedChanges([
        'apps/product/src/features/timeblock/components/Foo.tsx',
        'docs/engineering/data/architecture-inventory.md',
      ]),
    ).toBe(false);
  });

  it('前方一致で別ディレクトリを巻き込まない', () => {
    // `docs/engineering/data/architecture-inventory.md` は `architecture` で始まるが別物
    expect(hasWatchedChanges(['docs/engineering/data/architecture-inventory.md'])).toBe(false);
    expect(hasWatchedChanges(['scripts/lib/architecture-map-extra/x.ts'])).toBe(false);
  });
});

describe('likec4-validate: advisory の契約', () => {
  // report は `::warning::` を stdout へ出す。テストから素で呼ぶと GitHub Actions が
  // それを本物の annotation として拾い、**全 PR に偽の「model が invalid」警告が出る**
  // （実測: PR #2788 の Unit Tests job）。出力ごと握り潰して呼ぶ。
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalid でも docs-guard を落とさない', () => {
    expect(reportLikeC4ValidateCheck({ outcome: 'invalid', detail: 'boom' })).toBe(true);
  });

  it('likec4 を取得できなくても落とさない（ネットワーク断で merge を止めない）', () => {
    expect(reportLikeC4ValidateCheck({ outcome: 'unavailable', detail: 'offline' })).toBe(true);
  });

  it('skip / valid も当然 true', () => {
    expect(reportLikeC4ValidateCheck({ outcome: 'skipped' })).toBe(true);
    expect(reportLikeC4ValidateCheck({ outcome: 'valid' })).toBe(true);
  });

  it('version は固定する（dlx が勝手に major を上げると構文判定が変わる）', () => {
    expect(LIKEC4_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
