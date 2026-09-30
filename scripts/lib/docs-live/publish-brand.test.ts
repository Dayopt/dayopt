import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PUBLIC_DOCUMENT_BUILD_INPUTS } from '../../ci/impact.mjs';
import { publishBrandDocuments } from './publish-brand.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-public-docs-'));
  mkdirSync(join(root, 'docs/business'), { recursive: true });
  mkdirSync(join(root, 'apps/web/public/brand'), { recursive: true });
  writeFileSync(join(root, 'docs/business/brand.md'), '# Canonical brand\n');
  writeFileSync(join(root, 'apps/web/public/brand/README.md'), 'outdated');
  writeFileSync(join(root, 'apps/web/public/brand/logo.svg'), '<svg/>');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('配布 README と実際の zip の README を同じ正本に揃え、正本の変更を次の生成に反映する', async () => {
  const dest = join(root, 'apps/web/public/brand');
  await publishBrandDocuments(root, 'web');
  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('# Canonical brand\n');
  expect(
    execFileSync('unzip', ['-p', join(dest, 'dayopt-brand-F.zip'), 'README.md'], {
      encoding: 'utf8',
    }),
  ).toBe('# Canonical brand\n');
  const first = readFileSync(join(dest, 'dayopt-brand-F.zip'));
  await publishBrandDocuments(root, 'web');
  expect(readFileSync(join(dest, 'dayopt-brand-F.zip'))).toEqual(first);
  writeFileSync(join(root, 'docs/business/brand.md'), '# Changed brand\n');
  await publishBrandDocuments(root, 'web');
  expect(
    execFileSync('unzip', ['-p', join(dest, 'dayopt-brand-F.zip'), 'README.md'], {
      encoding: 'utf8',
    }),
  ).toBe('# Changed brand\n');
  expect(readFileSync(join(dest, 'logo.svg'), 'utf8')).toBe('<svg/>');
});

it('正本が消えた時は古い配布物で生成成功とせず、ビルドを失敗させる', async () => {
  rmSync(join(root, 'docs/business/brand.md'));
  await expect(publishBrandDocuments(root, 'web')).rejects.toThrow();
  expect(readFileSync(join(root, 'apps/web/public/brand/README.md'), 'utf8')).toBe('outdated');
});

it.each(['product', 'web'] as const)(
  '%s の実際の build コマンドは配布生成後に Next を呼び、生成失敗なら Next を呼ばない',
  (app) => {
    const repo = resolve(import.meta.dirname, '../../..');
    for (const path of PUBLIC_DOCUMENT_BUILD_INPUTS) {
      if (!path.endsWith('.ts')) continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(repo, path), join(root, path));
    }
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    for (const dep of ['glob', 'mdast-util-from-markdown', 'tsx', 'typescript'])
      symlinkSync(join(repo, 'node_modules', dep), join(root, 'node_modules', dep));
    symlinkSync(join(repo, 'node_modules/.bin/tsx'), join(root, 'node_modules/.bin/tsx'));
    writeFileSync(
      join(root, 'node_modules/.bin/next'),
      '#!/bin/sh\ntest -f public/brand/dayopt-brand-F.zip || exit 91\nprintf next-called > next-called\n',
      { mode: 0o755 },
    );
    const dir = join(root, 'apps', app);
    mkdirSync(join(dir, 'public/brand'), { recursive: true });
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    symlinkSync(join(root, 'node_modules/.bin/next'), join(dir, 'node_modules/.bin/next'));
    writeFileSync(join(dir, 'public/brand/logo.svg'), '<svg/>');
    const manifest = JSON.parse(readFileSync(join(repo, 'apps', app, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          build: manifest.scripts.build,
          'prepare:brand-docs': manifest.scripts['prepare:brand-docs'],
        },
      }),
    );
    execFileSync('pnpm', ['build'], { cwd: dir, stdio: 'pipe' });
    expect(readFileSync(join(dir, 'next-called'), 'utf8')).toBe('next-called');
    expect(
      execFileSync('unzip', ['-p', join(dir, 'public/brand/dayopt-brand-F.zip'), 'README.md'], {
        encoding: 'utf8',
      }),
    ).toBe('# Canonical brand\n');
    rmSync(join(dir, 'next-called'));
    rmSync(join(root, 'docs/business/brand.md'));
    expect(() => execFileSync('pnpm', ['build'], { cwd: dir, stdio: 'pipe' })).toThrow();
    expect(existsSync(join(dir, 'next-called'))).toBe(false);
  },
);
