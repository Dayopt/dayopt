import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  gitStorybookDiff,
  readSnapshot,
  resolveStorybookIgnore,
  storybookInputs,
} from './storybook-impact.mjs';

const base = 'a'.repeat(40);
const target = 'b'.repeat(40);
function snapshot(extra: Record<string, string> = {}) {
  return new Map(
    Object.entries({
      'apps/storybook/package.json': JSON.stringify({
        name: '@dayopt/storybook',
        dependencies: { '@dayopt/components': 'workspace:*' },
      }),
      'apps/product/package.json': JSON.stringify({ name: '@dayopt/product' }),
      'apps/web/package.json': JSON.stringify({ name: '@dayopt/web' }),
      'packages/components/package.json': JSON.stringify({
        name: '@dayopt/components',
        dependencies: { '@dayopt/tokens': 'workspace:*' },
      }),
      'packages/tokens/package.json': JSON.stringify({ name: '@dayopt/tokens' }),
      'apps/product/src/components/Card.tsx': 'export const Card = 1;',
      'apps/product/src/app/api/health/route.ts': 'export const GET = 1;',
      'packages/tokens/src/colors.ts': 'export const colors = 1;',
      ...extra,
    }),
  );
}
function decision(changed: string[], before = snapshot(), after = before) {
  return resolveStorybookIgnore({
    prevSha: base,
    currentSha: target,
    headImpl: () => target,
    diffImpl: () => changed,
    snapshotImpl: (sha: string) => (sha === base ? before : after),
  }).shouldBuild;
}

describe('Storybook ignored build', () => {
  it('runs standalone from the Vercel root with build=1 and skip=0', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const invoke = (previous: string) =>
      spawnSync(process.execPath, ['../../scripts/ci/storybook-impact.mjs'], {
        cwd: join(process.cwd(), 'apps/storybook'),
        env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: previous, VERCEL_GIT_COMMIT_SHA: sha },
        encoding: 'utf8',
      });
    expect(invoke('').status).toBe(1);
    expect(invoke(sha).status).toBe(0);
  });
  it('wires the dedicated Vercel project to the standalone ignored-build CLI', () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), 'apps/storybook/vercel.json'), 'utf8'),
    );
    expect(config.framework).toBeNull();
    expect(config.ignoreCommand).toBe('node ../../scripts/ci/storybook-impact.mjs');
    expect(config.buildCommand).toBe('pnpm build-storybook');
    expect(config.installCommand).toBe('pnpm install --frozen-lockfile');
    expect(config.outputDirectory).toBe('storybook-static');
  });
  it('tracks directly imported backend binary assets', () => {
    const files = snapshot({
      'apps/product/src/components/Card.tsx': "import image from '../server/image.svg';",
      'apps/product/src/server/image.svg': '',
    });
    expect(decision(['apps/product/src/server/image.svg'], files)).toBe(true);
  });

  it.each([
    'apps/product/src/components/Card.tsx',
    'apps/web/src/Page.stories.tsx',
    'apps/product/src/globals.css',
    'apps/web/public/logo.svg',
    'apps/storybook/.storybook/main.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/ci/storybook-impact.mjs',
    'packages/tokens/src/colors.ts',
  ])('builds frontend/config/dependency input %s', (path) => {
    expect(decision([path])).toBe(true);
  });
  it.each([
    'docs/test.md',
    'apps/web/content/docs/help.mdx',
    'apps/product/src/lib/mcp/tools.ts',
    'supabase/migrations/123.sql',
    'apps/product/src/app/api/health/route.ts',
    'apps/product/src/features/foo/server/handler.ts',
    'apps/product/src/components/Card.test.tsx',
    'packages/unrelated/src/index.ts',
  ])('skips unrelated input %s on main and Preview alike', (path) => {
    expect(decision([path])).toBe(false);
  });
  it('follows aliases and relative imports/reexports into backend transitively', () => {
    const files = snapshot({
      'apps/product/src/components/Card.tsx': "import { x } from '@/features/foo/server/index';",
      'apps/product/src/features/foo/server/index.ts': "export { x } from './handler';",
      'apps/product/src/features/foo/server/handler.ts':
        "export { x } from '../../../lib/mcp/tools';",
      'apps/product/src/lib/mcp/tools.ts': 'export const x = 1;',
    });
    expect(decision(['apps/product/src/features/foo/server/handler.ts'], files)).toBe(true);
    expect(decision(['apps/product/src/app/api/health/route.ts'], files)).toBe(false);
    expect(decision(['apps/product/src/lib/mcp/tools.ts'], files)).toBe(true);
  });
  it('checks old imports/dependencies as well as new ones for deletions and renames', () => {
    const before = snapshot({
      'apps/product/src/components/Card.tsx': "import '@/features/foo/server/old';",
      'apps/product/src/features/foo/server/old.ts': 'export {};',
    });
    expect(
      decision(
        [
          'apps/product/src/features/foo/server/old.ts',
          'apps/product/src/features/foo/server/new.ts',
        ],
        before,
        snapshot(),
      ),
    ).toBe(true);
  });
  it('follows imported backend code outside workspace folders', () => {
    const files = snapshot({
      'apps/product/src/components/Card.tsx': "import '../../../../scripts/backend-helper';",
      'scripts/backend-helper.ts': "export { x } from '../supabase/functions/shared';",
      'supabase/functions/shared.ts': 'export const x = 1;',
    });
    expect(decision(['supabase/functions/shared.ts'], files)).toBe(true);
  });
  it('handles local dynamic templates and glob dependencies without including unrelated backend', () => {
    const files = snapshot({
      'apps/product/src/components/Card.tsx':
        'import(`../server/${name}.ts`); import.meta.glob("../api/*.ts");',
      'apps/product/src/server/a.ts': 'export {};',
      'apps/product/src/api/a.ts': 'export {};',
    });
    expect(decision(['apps/product/src/server/a.ts'], files)).toBe(true);
    expect(decision(['apps/product/src/api/a.ts'], files)).toBe(true);
    expect(decision(['apps/product/src/app/api/health/route.ts'], files)).toBe(false);
  });
  it('builds for quoted-prefix concatenated dynamic imports', () => {
    const files = snapshot({
      'apps/product/src/components/Card.tsx': "import('../server/' + name + '.ts');",
      'apps/product/src/server/helper.ts': 'export {};',
    });
    expect(decision(['apps/product/src/server/helper.ts'], files)).toBe(true);
  });
  it('over-approximates opaque computed imports', () => {
    expect(
      decision(
        ['apps/product/src/app/api/health/route.ts'],
        snapshot({ 'apps/product/src/components/Card.tsx': 'import(moduleName);' }),
      ),
    ).toBe(true);
  });
  it('reads transitive manifest edges rather than a fixed package allowlist', () => {
    expect(storybookInputs(snapshot()).directories.has('packages/tokens')).toBe(true);
    expect(decision(['packages/tokens/package.json'])).toBe(true);
  });
  it('builds when workspace graph is incomplete', () => {
    const files = snapshot();
    files.delete('packages/tokens/package.json');
    expect(decision(['docs/test.md'], files)).toBe(true);
  });
  it.each([undefined, '', '0'.repeat(40), 'invalid'])(
    'builds first deploy or unavailable history %s',
    (prevSha) => {
      expect(
        resolveStorybookIgnore({
          prevSha,
          currentSha: target,
          headImpl: () => target,
          diffImpl: () => {
            throw Error('missing object');
          },
        }).shouldBuild,
      ).toBe(true);
    },
  );
  it('builds on wrong checkout, missing target and git failures', () => {
    expect(resolveStorybookIgnore({ prevSha: base, currentSha: undefined }).shouldBuild).toBe(true);
    expect(
      resolveStorybookIgnore({ prevSha: base, currentSha: target, headImpl: () => base })
        .shouldBuild,
    ).toBe(true);
    expect(
      resolveStorybookIgnore({
        prevSha: base,
        currentSha: target,
        headImpl: () => {
          throw Error('git unavailable');
        },
      }).shouldBuild,
    ).toBe(true);
  });
  it('skips an established empty diff and builds unknown inputs', () => {
    expect(decision([])).toBe(false);
    expect(decision(['unknown-build-config'])).toBe(true);
  });
  it('reads committed UTF-8 blobs and uses no-renames git diff for both sides', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'storybook-impact-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    try {
      git('init');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.com');
      mkdirSync(join(cwd, 'apps/example'), { recursive: true });
      writeFileSync(join(cwd, 'apps/example/file.json'), '{"label":"日本語"}');
      git('add', '.');
      git('commit', '-m', 'base');
      const first = git('rev-parse', 'HEAD');
      git('mv', 'apps/example/file.json', 'apps/example/new.json');
      git('commit', '-m', 'rename');
      const last = git('rev-parse', 'HEAD');
      expect(gitStorybookDiff(cwd, first, last).sort()).toEqual([
        'apps/example/file.json',
        'apps/example/new.json',
      ]);
      const shallow = join(cwd, 'shallow');
      execFileSync('git', ['clone', '--depth=1', `file://${cwd}`, shallow], { stdio: 'ignore' });
      expect(
        resolveStorybookIgnore({ cwd: shallow, prevSha: first, currentSha: last }).shouldBuild,
      ).toBe(true);
      expect(readSnapshot(cwd, first).get('apps/example/file.json')).toBe('{"label":"日本語"}');
      expect(resolveStorybookIgnore({ cwd, prevSha: first, currentSha: last }).shouldBuild).toBe(
        true,
      );
      expect(
        resolveStorybookIgnore({ cwd, prevSha: 'c'.repeat(40), currentSha: last }).shouldBuild,
      ).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
