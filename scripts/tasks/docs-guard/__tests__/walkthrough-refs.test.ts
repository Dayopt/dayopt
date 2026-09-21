import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkWalkthroughRefs, extractWalkthroughRefs } from '../checks/walkthrough-refs.ts';

function html(json: unknown): string {
  return `<html><script type="application/json" id="walkthrough-data">${JSON.stringify(json)}</script></html>`;
}

describe('extractWalkthroughRefs', () => {
  it('入れ子のどこにある refs も拾う', () => {
    const refs = extractWalkthroughRefs(
      html({
        scenarios: [
          {
            hops: [
              {
                refs: [{ path: 'a.ts', find: 'foo' }],
                fails: [{ refs: [{ path: 'b.ts', find: 'bar' }] }],
              },
            ],
          },
        ],
        outages: { items: [{ refs: [{ path: 'c.md', find: '## baz' }] }] },
      }),
    );
    expect(refs).toEqual([
      { path: 'a.ts', find: 'foo' },
      { path: 'b.ts', find: 'bar' },
      { path: 'c.md', find: '## baz' },
    ]);
  });

  it('JSON ブロックが無ければ throw する', () => {
    expect(() => extractWalkthroughRefs('<html></html>')).toThrow();
  });
});

describe('checkWalkthroughRefs', () => {
  const root = mkdtempSync(join(tmpdir(), 'walkthrough-refs-'));
  writeFileSync(join(root, 'real.ts'), 'export function createPlan() {}\n');

  it('在るファイルの在る文字列は通す', () => {
    expect(checkWalkthroughRefs([{ path: 'real.ts', find: 'createPlan' }], root)).toEqual([]);
  });

  it('消えたファイルを報告する', () => {
    const violations = checkWalkthroughRefs([{ path: 'gone.ts', find: 'createPlan' }], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('ファイルが存在しない');
  });

  it('改名された symbol を報告する', () => {
    const violations = checkWalkthroughRefs([{ path: 'real.ts', find: 'createPlanV2' }], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('find の文字列がファイルに無い');
  });

  it('find が空なら報告する', () => {
    expect(checkWalkthroughRefs([{ path: 'real.ts', find: '' }], root)).toHaveLength(1);
  });

  it('repo の外を指す path を報告する', () => {
    const violations = checkWalkthroughRefs([{ path: '../outside.ts', find: 'x' }], root);
    expect(violations[0]?.reason).toBe('repo の外を指している');
  });
});
