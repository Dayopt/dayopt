import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyAllScripts,
  classifyHits,
  collectPackageJsonEntries,
  listNonTestScriptFiles,
} from '../scripts-taxonomy';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) {
    const dir = temporaryDirectories.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** repoRoot 直下に fixture ファイル群を書き出す（path はディレクトリ区切りを含んでよい）。 */
function makeFixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dayopt-scripts-taxonomy-'));
  temporaryDirectories.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe('Vercel の CI command 参照', () => {
  it.each(['buildCommand', 'installCommand', 'ignoreCommand'])(
    '%s の実行scriptはCI、その他JSONの一覧は参照に数えない',
    (field) => {
      const root = makeFixtureRepo({
        'scripts/ci/deployment.mjs': 'export const check = 1;',
        'scripts/ci/inventory-only.mjs': 'export const inventory = 1;',
        'apps/storybook/vercel.json': JSON.stringify({
          [field]: 'node ../../scripts/ci/deployment.mjs',
          notes: ['scripts/ci/inventory-only.mjs'],
        }),
        'docs/runbook.md': 'Run `node scripts/ci/deployment.mjs`.',
      });
      const entries = classifyAllScripts(root);
      expect(entries.find((entry) => entry.path === 'scripts/ci/deployment.mjs')).toMatchObject({
        category: 'ci',
        hits: { workflow: [`apps/storybook/vercel.json#${field}`] },
      });
      expect(
        entries.find((entry) => entry.path === 'scripts/ci/inventory-only.mjs')?.category,
      ).toBe('unreferenced');
    },
  );
});

describe('classifyHits', () => {
  it('優先順位どおり最初に該当したカテゴリを返す(pkg > workflow > hooks > agent > runbook > lib)', () => {
    expect(
      classifyHits({
        pkg: ['package.json#foo'],
        workflow: ['.github/workflows/x.yml'],
        husky: [],
        claudeHook: [],
        claudeSettings: [],
        claudeRule: [],
        claudeSkill: [],
        docs: [],
        importedBy: [],
      }),
    ).toBe('tasks');

    expect(
      classifyHits({
        pkg: [],
        workflow: ['.github/workflows/x.yml'],
        husky: ['.husky/pre-push'],
        claudeHook: [],
        claudeSettings: [],
        claudeRule: [],
        claudeSkill: [],
        docs: [],
        importedBy: [],
      }),
    ).toBe('ci');

    expect(
      classifyHits({
        pkg: [],
        workflow: [],
        husky: ['.husky/pre-push'],
        claudeHook: [],
        claudeSettings: [],
        claudeRule: ['.agents/skills/dispatch/SKILL.md'],
        claudeSkill: [],
        docs: [],
        importedBy: [],
      }),
    ).toBe('hooks');

    expect(
      classifyHits({
        pkg: [],
        workflow: [],
        husky: [],
        claudeHook: [],
        claudeSettings: [],
        claudeRule: ['.agents/skills/dispatch/SKILL.md'],
        docs: ['docs/x.md'],
        claudeSkill: [],
        importedBy: [],
      }),
    ).toBe('agent');

    expect(
      classifyHits({
        pkg: [],
        workflow: [],
        husky: [],
        claudeHook: [],
        claudeSettings: [],
        claudeRule: [],
        claudeSkill: [],
        docs: ['docs/x.md'],
        importedBy: ['scripts/other.ts'],
      }),
    ).toBe('runbook');

    expect(
      classifyHits({
        pkg: [],
        workflow: [],
        husky: [],
        claudeHook: [],
        claudeSettings: [],
        claudeRule: [],
        claudeSkill: [],
        docs: [],
        importedBy: ['scripts/other.ts'],
      }),
    ).toBe('lib');

    expect(
      classifyHits({
        pkg: [],
        workflow: [],
        husky: [],
        claudeHook: [],
        claudeSettings: [],
        claudeRule: [],
        claudeSkill: [],
        docs: [],
        importedBy: [],
      }),
    ).toBe('unreferenced');
  });
});

describe('listNonTestScriptFiles', () => {
  it('__tests__/ 配下と *.test.ts を除外する(コロケート配置・サブディレクトリ配置いずれも)', () => {
    const root = makeFixtureRepo({
      'scripts/a.ts': '',
      'scripts/a.test.ts': '',
      'scripts/__tests__/b.test.ts': '',
      'scripts/sub/c.mjs': '',
      'scripts/sub/c.test.ts': '',
      'scripts/not-a-script.md': '',
    });

    const files = listNonTestScriptFiles(root);
    expect(files.sort()).toEqual(['scripts/a.ts', 'scripts/sub/c.mjs']);
  });
});

describe('collectPackageJsonEntries', () => {
  it('root と apps/packages 配下の package.json を両方拾う', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: { build: 'echo root' } }),
      'apps/product/package.json': JSON.stringify({ scripts: { dev: 'echo dev' } }),
      'packages/foo/package.json': JSON.stringify({ scripts: { test: 'echo test' } }),
      // node_modules 配下の package.json は除外されること
      'node_modules/dep/package.json': JSON.stringify({ scripts: { postinstall: 'echo x' } }),
    });

    const entries = collectPackageJsonEntries(root);
    const names = entries.map((e) => `${e.pkgFile}#${e.name}`).sort();
    expect(names).toEqual([
      'apps/product/package.json#dev',
      'package.json#build',
      'packages/foo/package.json#test',
    ]);
  });
});

describe('classifyAllScripts (統合)', () => {
  it('拡張子なし import を解決して import 元を lib と判定する', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: {} }),
      'scripts/consumer.ts': "import { helper } from './helper';\nhelper();\n",
      'scripts/helper.ts': 'export function helper() {}\n',
    });

    const result = classifyAllScripts(root);
    const helper = result.find((r) => r.path === 'scripts/helper.ts');
    expect(helper?.category).toBe('lib');
    expect(helper?.hits.importedBy).toEqual(['scripts/consumer.ts']);
  });

  it('package.json script エントリから呼ばれる script を tasks 判定する', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: { 'lint:tokens': 'tsx scripts/check-tokens.ts' } }),
      'scripts/check-tokens.ts': '',
    });

    const result = classifyAllScripts(root);
    const target = result.find((r) => r.path === 'scripts/check-tokens.ts');
    expect(target?.category).toBe('tasks');
    expect(target?.hits.pkg).toEqual(['package.json#lint:tokens']);
  });

  it('.github/workflows からのみ呼ばれる script を ci 判定する', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: {} }),
      '.github/workflows/nightly.yml': 'run: node scripts/nightly.mjs\n',
      'scripts/nightly.mjs': '',
    });

    const result = classifyAllScripts(root);
    const target = result.find((r) => r.path === 'scripts/nightly.mjs');
    expect(target?.category).toBe('ci');
  });

  it('.husky からのみ呼ばれる script を hooks 判定する', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: {} }),
      '.husky/pre-push': 'node scripts/ops/pre-push-diff.mjs\n',
      'scripts/ops/pre-push-diff.mjs': '',
    });

    const result = classifyAllScripts(root);
    const target = result.find((r) => r.path === 'scripts/ops/pre-push-diff.mjs');
    expect(target?.category).toBe('hooks');
  });

  it('.claude/settings.json の hooks 設定からのみ呼ばれる script を hooks 判定する（#2479、hooks 実体の scripts/hooks/ 移動後の主経路）', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: {} }),
      '.claude/settings.json': JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ command: 'scripts/hooks/session-start.sh' }] }] },
      }),
      'scripts/hooks/session-start.sh': '',
    });

    const result = classifyAllScripts(root);
    const target = result.find((r) => r.path === 'scripts/hooks/session-start.sh');
    expect(target?.category).toBe('hooks');
  });

  it('.claude/rules または CLAUDE.md からのみ呼ばれる script を agent 判定する', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: {} }),
      'CLAUDE.md': 'node scripts/ops/codex-input.mjs issue <番号>\n',
      'scripts/ops/codex-input.mjs': '',
    });

    const result = classifyAllScripts(root);
    const target = result.find((r) => r.path === 'scripts/ops/codex-input.mjs');
    expect(target?.category).toBe('agent');
  });

  it('docs からのみ参照される script を runbook 判定する', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: {} }),
      'docs/operations/runbook.md': '`scripts/admin-delete-user.sh` を実行する\n',
      'scripts/admin-delete-user.sh': '',
    });

    const result = classifyAllScripts(root);
    const target = result.find((r) => r.path === 'scripts/admin-delete-user.sh');
    expect(target?.category).toBe('runbook');
  });

  it('どこからも参照されない script を unreferenced 判定する', () => {
    const root = makeFixtureRepo({
      'package.json': JSON.stringify({ scripts: {} }),
      'scripts/orphan.ts': '',
    });

    const result = classifyAllScripts(root);
    const target = result.find((r) => r.path === 'scripts/orphan.ts');
    expect(target?.category).toBe('unreferenced');
  });
});

describe('Codex hook registration', () => {
  it('classifies a launcher referenced only by .codex/hooks.json as a hook', () => {
    const root = makeFixtureRepo({
      '.codex/hooks.json': JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ command: 'bash scripts/hooks/codex-guard.sh' }] }] },
      }),
      'scripts/hooks/codex-guard.sh': '#!/bin/sh\nexit 0\n',
    });
    const result = classifyAllScripts(root).find(
      (entry) => entry.path === 'scripts/hooks/codex-guard.sh',
    );
    expect(result?.category).toBe('hooks');
  });
});
