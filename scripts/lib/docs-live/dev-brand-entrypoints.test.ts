import { spawnSync } from 'node:child_process';
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
import { expect, it } from 'vitest';

import { PUBLIC_DOCUMENT_BUILD_INPUTS } from '../../ci/impact.mjs';

const entrypoints = [
  { app: 'product', command: 'dev', nextArgs: 'dev' },
  { app: 'product', command: 'dev:op', nextArgs: 'dev' },
  { app: 'product', command: 'dev:raw', nextArgs: 'dev' },
  { app: 'web', command: 'dev', nextArgs: 'dev' },
  { app: 'web', command: 'dev:e2e', nextArgs: 'dev -p 3001' },
] as const;

it.each(entrypoints)(
  '$app $command は clean checkout で配布生成後に Next dev を呼び、生成失敗では呼ばない',
  ({ app, command, nextArgs }) => {
    const repo = resolve(import.meta.dirname, '../../..');
    const root = mkdtempSync(join(tmpdir(), 'dayopt-brand-dev-'));
    const dir = join(root, 'apps', app);
    const bin = join(root, 'node_modules/.bin');
    const write = (path: string, content: string, executable = false) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content, executable ? { mode: 0o755 } : undefined);
    };
    try {
      for (const path of PUBLIC_DOCUMENT_BUILD_INPUTS) {
        if (!path.endsWith('.ts')) continue;
        mkdirSync(dirname(join(root, path)), { recursive: true });
        copyFileSync(join(repo, path), join(root, path));
      }
      mkdirSync(bin, { recursive: true });
      for (const dep of ['glob', 'mdast-util-from-markdown', 'tsx', 'typescript'])
        symlinkSync(join(repo, 'node_modules', dep), join(root, 'node_modules', dep));
      symlinkSync(join(repo, 'node_modules/.bin/tsx'), join(bin, 'tsx'));
      write('package.json', '{"private":true}');
      write('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
      const manifest = JSON.parse(
        readFileSync(join(repo, 'apps', app, 'package.json'), 'utf8'),
      ) as {
        name: string;
        scripts: Record<string, string>;
      };
      const scripts = Object.fromEntries(
        Object.entries(manifest.scripts).filter(
          ([key]) => key.startsWith('dev') || key === 'prepare:brand-docs',
        ),
      );
      write(
        `apps/${app}/package.json`,
        JSON.stringify({ name: manifest.name, private: true, scripts }),
      );
      write('docs/business/brand.md', '# Canonical dev brand\n');
      write(`apps/${app}/public/brand/logo.svg`, '<svg/>');
      write(
        'node_modules/.bin/next',
        '#!/bin/sh\nset -eu\ntest -s public/brand/README.md\ntest -s public/brand/dayopt-brand-F.zip\nprintf "%s" "$*" > next-called\n',
        true,
      );
      mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
      symlinkSync(join(bin, 'next'), join(dir, 'node_modules/.bin/next'));
      // Preserve the actual product wrapper and pnpm delegation. Only external
      // local Supabase / 1Password / psql executables are isolated fixture stubs.
      mkdirSync(join(root, 'scripts/tasks'), { recursive: true });
      copyFileSync(
        join(repo, 'scripts/tasks/dev-with-op.sh'),
        join(root, 'scripts/tasks/dev-with-op.sh'),
      );
      write('.op-env.agent', 'TEST_VALUE=op://fixture/item/field\n');
      write(
        'node_modules/.bin/supabase',
        '#!/bin/sh\nprintf \'API_URL="http://127.0.0.1:54321"\\nANON_KEY="fixture-anon"\\nSERVICE_ROLE_KEY="fixture-role"\\n\'\n',
        true,
      );
      write('node_modules/.bin/psql', '#!/bin/sh\nexit 0\n', true);
      write(
        'node_modules/.bin/op',
        '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
        true,
      );
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OP_ENV_FILE: '.op-env.agent',
        DAYOPT_SUPABASE_TARGET: 'local',
      };
      const run = () => spawnSync('pnpm', [command], { cwd: dir, env, encoding: 'utf8' });
      expect(existsSync(join(dir, 'public/brand/README.md'))).toBe(false);
      expect(existsSync(join(dir, 'public/brand/dayopt-brand-F.zip'))).toBe(false);
      const result = run();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(join(dir, 'next-called'), 'utf8')).toBe(nextArgs);
      expect(readFileSync(join(dir, 'public/brand/README.md'), 'utf8')).toBe(
        '# Canonical dev brand\n',
      );
      const archive = readFileSync(join(dir, 'public/brand/dayopt-brand-F.zip'));
      expect(archive.subarray(0, 2).toString()).toBe('PK');
      rmSync(join(dir, 'next-called'));
      rmSync(join(root, 'docs/business/brand.md'));
      expect(run().status).not.toBe(0);
      expect(existsSync(join(dir, 'next-called'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
