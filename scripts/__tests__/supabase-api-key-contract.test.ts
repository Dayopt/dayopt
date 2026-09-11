import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('Supabase API key migration contract', () => {
  it('production application sources do not read legacy environment names', () => {
    const files = execFileSync('git', ['ls-files', 'apps/product/src'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    expect(files.length).toBeGreaterThan(100);
    const violations = files.filter((file) =>
      /(?:NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)/.test(
        readFileSync(resolve(root, file), 'utf8'),
      ),
    );
    expect(violations).toEqual([]);
  });

  it.each([
    [
      'sb_secret_isolated_fixture',
      ['apikey: sb_secret_isolated_fixture', 'Content-Type: application/json'],
    ],
    [
      'eyJ.local.fixture',
      [
        'apikey: eyJ.local.fixture',
        'Authorization: Bearer eyJ.local.fixture',
        'Content-Type: application/json',
      ],
    ],
  ])('admin header generation supports %s without network access', (key, headers) => {
    const output = execFileSync(
      'bash',
      [
        '-c',
        'source scripts/runbook/admin-common.sh\nauth_headers_json\nprintf "%s\\n" "${AUTH_HEADERS[@]}"',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, SUPABASE_SECRET_KEY: key },
      },
    );
    expect(
      output
        .trim()
        .split('\n')
        .filter((part) => part !== '-H'),
    ).toEqual(headers);
  });
});
