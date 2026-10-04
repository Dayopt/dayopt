/**
 * turbo.json の build env 宣言と production build gate の契約を固定する。
 *
 * Vercel は turborepo 検出時に `turbo run build` で build する（#1701 の
 * Root Directory flip 以降）。Turborepo 2.x の strict env mode は、
 * `tasks.build.env` に宣言しない env を build process から剥がすため、
 * gate が要求する env の宣言漏れはそのまま production release の停止になる。
 *
 * - NEXT_PUBLIC_* は Next.js の framework inference で自動的に通るため宣言不要
 * - それ以外の gate 必須 env は、exact 名または prefix wildcard（`XXX_*`）で
 *   turbo.json に必ず載せる
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV } from '../../apps/product/production-build-gate.mjs';
import { REQUIRED_WEB_OPERATIONAL_BUILD_ENV } from '../../apps/web/production-build-gate.mjs';
import { REQUIRED_SENTRY_BUILD_ENV } from '../../packages/observability/build-gate.mjs';

const BUILD_GATE_PATHS = [
  '../../packages/observability/build-gate.mjs',
  '../../apps/product/production-build-gate.mjs',
  '../../apps/web/production-build-gate.mjs',
] as const;

const turboConfig = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../turbo.json', import.meta.url)), 'utf8'),
) as { tasks?: { build?: { env?: string[] } } };

const buildEnvDeclarations = turboConfig.tasks?.build?.env ?? [];

function isCoveredByBuildEnv(envName: string): boolean {
  // Next.js package の build では turbo の framework inference が通す。
  if (envName.startsWith('NEXT_PUBLIC_')) return true;

  return buildEnvDeclarations.some((declared) =>
    declared.endsWith('*') ? envName.startsWith(declared.slice(0, -1)) : envName === declared,
  );
}

describe('turbo build env contract', () => {
  it('build env宣言はexact名かprefix wildcardだけで構成する', () => {
    expect(buildEnvDeclarations.length).toBeGreaterThan(0);
    for (const declared of buildEnvDeclarations) {
      // negation（`!XXX`）や中間 wildcard を混ぜると下の coverage 判定が
      // 成立しなくなるため、宣言の形式ごと契約に含める。
      expect(declared, declared).toMatch(/^[A-Z][A-Z0-9_]*\*?$/);
    }
  });

  it.each([
    { gate: 'Sentry production gate', requiredEnvNames: REQUIRED_SENTRY_BUILD_ENV },
    {
      gate: 'Product operational gate',
      requiredEnvNames: REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV,
    },
    { gate: 'Web operational gate', requiredEnvNames: REQUIRED_WEB_OPERATIONAL_BUILD_ENV },
  ])('$gateの必須envをturbo.jsonのbuild envがカバーする', ({ requiredEnvNames }) => {
    const uncovered = requiredEnvNames.filter((envName: string) => !isCoveredByBuildEnv(envName));
    expect(uncovered).toEqual([]);
  });

  it('gate実装が読むenvプロパティをturbo.jsonのbuild envがカバーする', () => {
    // gate は VERCEL_ENV などを配列外で直接参照する。ソースを走査して
    // `env.XXX` の形の参照をすべて拾い、宣言漏れを検出する。
    for (const gatePath of BUILD_GATE_PATHS) {
      const source = readFileSync(fileURLToPath(new URL(gatePath, import.meta.url)), 'utf8');
      const referencedEnvNames = [...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/gu)].map(
        (match) => match[1]!,
      );
      expect(referencedEnvNames.length, gatePath).toBeGreaterThan(0);

      const uncovered = referencedEnvNames.filter((envName) => !isCoveredByBuildEnv(envName));
      expect(uncovered, gatePath).toEqual([]);
    }
  });
});

describe('turbo build artifact cache contract', () => {
  it('clean checkout の cache hit で両 app の brand 配布物を復元する', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'dayopt-turbo-brand-cache-'));
    const cacheDir = join(fixtureRoot, 'cache');
    const config = JSON.parse(readFileSync(join(repoRoot, 'turbo.json'), 'utf8'));
    const { packageManager } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const apps = ['product', 'web'];
    const artifacts = {
      'public/brand/README.md': '# Generated brand guide\n',
      'public/brand/dayopt-brand-F.zip': 'deterministic-zip-fixture\n',
    };

    function createCheckout(name: string): string {
      const checkout = join(fixtureRoot, name);
      const write = (path: string, content: string) => {
        mkdirSync(dirname(join(checkout, path)), { recursive: true });
        writeFileSync(join(checkout, path), content);
      };
      write(
        'package.json',
        JSON.stringify({ name: 'brand-cache-fixture', private: true, packageManager }),
      );
      write('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
      write(
        'pnpm-lock.yaml',
        "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  apps/product: {}\n  apps/web: {}\n",
      );
      write('turbo.json', JSON.stringify(config));
      write(
        '.gitignore',
        '.turbo/\n.next/\npublic/brand/README.md\npublic/brand/dayopt-brand-F.zip\n.build-ran\n',
      );
      for (const dependency of config.globalDependencies) write(dependency, 'fixture input\n');
      for (const app of apps) {
        write(
          `apps/${app}/package.json`,
          JSON.stringify({ name: `@fixture/${app}`, scripts: { build: 'node build.cjs' } }),
        );
        write(
          `apps/${app}/build.cjs`,
          `const fs = require('node:fs');\nfs.mkdirSync('public/brand', { recursive: true });\nfs.mkdirSync('.next', { recursive: true });\nfs.writeFileSync('.next/built.txt', 'built');\nfs.writeFileSync('.build-ran', 'executed');\nfor (const [path, content] of Object.entries(${JSON.stringify(artifacts)})) fs.writeFileSync(path, content);\n`,
        );
      }
      execFileSync('git', ['init', '--quiet'], { cwd: checkout });
      execFileSync('git', ['add', '.'], { cwd: checkout });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ],
        { cwd: checkout },
      );
      return checkout;
    }

    function build(checkout: string): string {
      return execFileSync(
        join(repoRoot, 'node_modules/.bin/turbo'),
        ['run', 'build', '--cache=local:rw', `--cache-dir=${cacheDir}`],
        {
          cwd: checkout,
          encoding: 'utf8',
          env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
        },
      );
    }

    try {
      const initial = createCheckout('initial');
      build(initial);
      for (const app of apps) {
        expect(existsSync(join(initial, 'apps', app, '.build-ran'))).toBe(true);
        for (const [path, content] of Object.entries(artifacts)) {
          expect(readFileSync(join(initial, 'apps', app, path), 'utf8')).toBe(content);
        }
      }

      const clean = createCheckout('clean');
      for (const app of apps) {
        for (const path of Object.keys(artifacts))
          expect(existsSync(join(clean, 'apps', app, path))).toBe(false);
      }
      const output = build(clean);
      expect(output).toMatch(/Cached:\s+2 cached, 2 total/);
      for (const app of apps) {
        // A cache hit must restore artifacts without rerunning prepare/build.
        expect(existsSync(join(clean, 'apps', app, '.build-ran'))).toBe(false);
        expect(readFileSync(join(clean, 'apps', app, '.next/built.txt'), 'utf8')).toBe('built');
        for (const [path, content] of Object.entries(artifacts)) {
          expect(
            existsSync(join(clean, 'apps', app, path)),
            `${app}/${path} restored from cache`,
          ).toBe(true);
          expect(readFileSync(join(clean, 'apps', app, path), 'utf8')).toBe(content);
        }
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
