import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectDocumentCatalog, documentPaths, renderDocumentCatalog } from './catalog.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-catalog-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('docs/ 以外・hidden な指示・新規文書も列挙し、ignore された依存文書を含めない', () => {
  for (const path of [
    'README.md',
    '.agents/skills/check/SKILL.md',
    'apps/web/content/legal/ja/privacy.mdx',
    'node_modules/dep/README.md',
  ]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), '# 本文\n');
  }
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  expect(documentPaths(root)).toEqual([
    '.agents/skills/check/SKILL.md',
    'README.md',
    'apps/web/content/legal/ja/privacy.mdx',
  ]);
  const entries = collectDocumentCatalog(root);
  expect(entries).toHaveLength(3);
  expect(entries.find((entry) => entry.path.includes('/legal/'))?.role).toContain('法務');
  expect(renderDocumentCatalog(entries)).toContain('対象: 3 ファイル');
});

it('新しい生成ファイル・削除したファイルを次の棚卸しで反映する', () => {
  writeFileSync(join(root, 'old.md'), '# old');
  expect(documentPaths(root)).toContain('old.md');
  rmSync(join(root, 'old.md'));
  writeFileSync(
    join(root, 'new.md'),
    '> **生成元**: `scripts/tasks/generate-architecture-map.ts`\n',
  );
  expect(collectDocumentCatalog(root)).toEqual([
    {
      path: 'new.md',
      origin: 'architecture',
      role: '運用・設計説明 + code/config/外部状態の写し候補',
      lines: 1,
    },
  ]);
});

it('Git の削除予定を一覧から外し、保存されていない配布説明は正本の alias として列挙する', () => {
  writeFileSync(join(root, 'deleted.md'), '# deleted');
  execFileSync('git', ['add', 'deleted.md'], { cwd: root });
  rmSync(join(root, 'deleted.md'));
  mkdirSync(join(root, 'docs/business'), { recursive: true });
  writeFileSync(join(root, 'docs/business/brand.md'), '# Source\n');
  const entries = collectDocumentCatalog(root);
  expect(entries.map((entry) => entry.path)).not.toContain('deleted.md');
  expect(entries.filter((entry) => entry.origin === 'brand').map((entry) => entry.path)).toEqual([
    'apps/product/public/brand/README.md',
    'apps/web/public/brand/README.md',
  ]);
  expect(entries.find((entry) => entry.origin === 'brand')?.role).toContain('保存本文なし');
});
