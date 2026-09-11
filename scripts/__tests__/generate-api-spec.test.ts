import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const rootDir = resolve(import.meta.dirname, '../..');
const temporaryDirectories: string[] = [];

function runGenerator(...args: string[]) {
  return spawnSync(
    'pnpm',
    ['--dir', 'apps/product', 'exec', 'tsx', '../../scripts/tasks/generate-api-spec.ts', ...args],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'dummy',
        NEXT_PUBLIC_SUPABASE_URL: 'https://dummy.supabase.co',
        SUPABASE_SECRET_KEY: 'dummy',
      },
    },
  );
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dayopt-api-spec-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('generate-api-spec.ts', () => {
  it('error response を含む OpenAPI spec を生成する', () => {
    const outputPath = join(createTemporaryDirectory(), 'openapi.json');

    const result = runGenerator('--output', outputPath);

    expect(result.status, result.stderr).toBe(0);
    const spec = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      components: { responses: Record<string, unknown> };
      openapi: string;
    };
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.components.responses).toHaveProperty('BadRequest');
    expect(spec.components.responses).toHaveProperty('InternalServerError');
  });

  it('--check は比較対象がない場合に失敗理由を返す', () => {
    const directory = createTemporaryDirectory();
    const outputPath = join(directory, 'missing', 'openapi.json');
    mkdirSync(join(directory, 'missing'));

    const result = runGenerator('--check', '--output', outputPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('API仕様書が見つかりません');
  });
});
