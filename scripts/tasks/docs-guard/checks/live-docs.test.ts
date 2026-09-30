import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FACT_DOCUMENT_SOURCES } from '../../../lib/docs-live/facts.ts';
import { LIVE_DOCUMENT_VIEWS, storedLiveBlock } from '../../../lib/docs-live/live-contract.ts';
import { runLiveDocsCheck, runLiveDocsCheckForArgs } from './live-docs.ts';

let root: string;

it('CI preset は今回の push 前検査だけを省き、通常経路は違反を検出する', () => {
  const failing = vi.fn(() => false);
  expect(runLiveDocsCheckForArgs(['--ci'], failing)).toBe(true);
  expect(failing).not.toHaveBeenCalled();
  vi.stubEnv('CI', '1');
  try {
    expect(runLiveDocsCheckForArgs([], failing)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
  expect(failing).toHaveBeenCalledOnce();
  expect(() => runLiveDocsCheckForArgs(['--unknown'], failing)).toThrow('Usage');
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-live-docs-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","scripts":{"check":"true"}}');
  for (const [path, views] of Object.entries(LIVE_DOCUMENT_VIEWS)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      (path.startsWith('.agents/') ? '---\nname: i18n\ndescription: fixture skill\n---\n\n' : '') +
        views.map((view) => storedLiveBlock(path, view)).join('\n\n'),
    );
  }
  for (const path of ['packages/billing/src', 'packages/config/src']) mkdirSync(join(root, path));
  for (const sources of Object.values(FACT_DOCUMENT_SOURCES)) {
    for (const source of sources) {
      const path = source.path.includes('*')
        ? source.path.includes('SKILL')
          ? '.agents/skills/test/SKILL.md'
          : '.github/workflows/test.yml'
        : source.path;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      const content = source.symbols
        ? source.symbols.map((symbol) => `export const ${symbol} = 1;`).join('\n')
        : path === '.claude/settings.json'
          ? JSON.stringify({ permissions: { allow: [], deny: [], ask: [] } })
          : path.endsWith('.json')
            ? JSON.stringify(
                Object.fromEntries((source.keys ?? ['app', 'common']).map((key) => [key, {}])),
              )
            : path.endsWith('/SKILL.md')
              ? '---\nname: test\ndescription: fixture skill\n---\n'
              : '# fixture';
      writeFileSync(
        join(root, path),
        path.endsWith('/package.json')
          ? JSON.stringify({ name: '@fixture/foundations', ...JSON.parse(content) })
          : content,
      );
    }
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('docs:check の check が正常入力を通し、手書き・marker 消失・文書消失を落とす', () => {
  expect(runLiveDocsCheck(root), JSON.stringify(vi.mocked(console.error).mock.calls)).toBe(true);
  const path = 'packages/config/README.md';
  writeFileSync(
    join(root, path),
    storedLiveBlock(path, 'files').replace(
      '<!-- docs-live:files:end -->',
      '- old.ts\n<!-- docs-live:files:end -->',
    ),
  );
  expect(runLiveDocsCheck(root)).toBe(false);
  writeFileSync(join(root, path), '# 構造\n- old.ts');
  expect(runLiveDocsCheck(root)).toBe(false);
  rmSync(join(root, path));
  expect(runLiveDocsCheck(root)).toBe(false);
});

it.each(['README.md', 'dayopt-brand-F.zip'])(
  'ignore を上書きして配布生成物 %s を Git に再追加すると落とす',
  (name) => {
    mkdirSync(join(root, 'docs/business'), { recursive: true });
    writeFileSync(join(root, 'docs/business/brand.md'), '# Brand');
    const path = `apps/web/public/brand/${name}`;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), '古い配布生成物');
    writeFileSync(join(root, '.gitignore'), 'apps/web/public/brand/*\n');
    expect(runLiveDocsCheck(root), JSON.stringify(vi.mocked(console.error).mock.calls)).toBe(true);
    execFileSync('git', ['add', '-f', '--', path], { cwd: root });
    expect(runLiveDocsCheck(root)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Git 登録は禁止'));
  },
);
