import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderFacts } from './facts.ts';

let root: string;
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-facts-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('許可式と禁止識別子の矛盾を勝手に解消せず、変更を次回の読取へ反映する', () => {
  const path = 'apps/product/.licensrc.json';
  put(
    path,
    JSON.stringify({
      onlyAllow: 'MIT;LGPL-3.0-or-later',
      prohibited: { licenses: ['LGPL-3.0-or-later'] },
      warning: { licenses: [] },
    }),
  );
  const output = renderFacts(root, 'docs/operations/tooling.md');
  expect(output.match(/LGPL-3.0-or-later/g)).toHaveLength(2);
  put(
    path,
    JSON.stringify({ onlyAllow: 'MIT', prohibited: { licenses: [] }, warning: { licenses: [] } }),
  );
  expect(renderFacts(root, 'docs/operations/tooling.md')).not.toContain('LGPL');
  put(path, '{}');
  expect(() => renderFacts(root, 'docs/operations/tooling.md')).toThrow('onlyAllow');
});

it('permissionsの実値を展開せず件数を取得し、skill追加を毎回発見する', () => {
  put(
    '.claude/settings.json',
    JSON.stringify({ permissions: { allow: ['private-rule'], deny: [], ask: [] } }),
  );
  put('.agents/skills/first/SKILL.md', '---\nname: first\ndescription: first meaning\n---\n');
  const before = renderFacts(root, 'docs/learn/system/agents.md');
  expect(before).toContain('| allow | 1 |');
  expect(before).not.toContain('private-rule');
  put('.agents/skills/second/SKILL.md', '---\nname: second\ndescription: second meaning\n---\n');
  expect(renderFacts(root, 'docs/learn/system/agents.md')).toContain('second meaning');
});

it('TypeScriptを実行せず抽出し、構文異常やsymlinkで停止する', () => {
  const path = 'apps/product/src/lib/analytics/product-events.ts';
  put(
    path,
    "throw new Error('must not run');\nexport const PRODUCT_EVENT_NAMES = ['literal'] as const;",
  );
  expect(renderFacts(root, 'docs/operations/product-analytics.md')).toContain("['literal']");
  put(path, 'export const PRODUCT_EVENT_NAMES = [;');
  expect(() => renderFacts(root, 'docs/operations/product-analytics.md')).toThrow('構文');
  rmSync(join(root, path));
  put('outside.ts', 'not a source');
  symlinkSync(join(root, 'outside.ts'), join(root, path));
  expect(() => renderFacts(root, 'docs/operations/product-analytics.md')).toThrow('symlink');
});
