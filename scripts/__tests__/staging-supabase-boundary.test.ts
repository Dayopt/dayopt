import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { envSchema, forbiddenFields, productionEnvSchema } from '../tasks/env/schema';

// agent には常設 staging が無く、置けば production の複製になる 4 field。
const SUPABASE_CONNECTION_FIELDS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_DB_PASSWORD',
] as const;

const opEnvExample = readFileSync(
  fileURLToPath(new URL('../../.op-env.agent.example', import.meta.url)),
  'utf8',
);

const setup1PasswordScript = readFileSync(
  fileURLToPath(new URL('../runbook/setup-1password.sh', import.meta.url)),
  'utf8',
);

const devWithOpScript = readFileSync(
  fileURLToPath(new URL('../tasks/dev-with-op.sh', import.meta.url)),
  'utf8',
);

const adminEnvExample = readFileSync(
  fileURLToPath(new URL('../../.op-env.human.example', import.meta.url)),
  'utf8',
);

const gitignore = readFileSync(fileURLToPath(new URL('../../.gitignore', import.meta.url)), 'utf8');

/** setup-1password.sh から Staging の supabase item を作る 1 コマンドだけを切り出す。 */
function stagingSupabaseItemBlock(): string {
  const start = setup1PasswordScript.indexOf('--vault=agent --title=supabase');
  expect(start).toBeGreaterThan(-1);
  const end = setup1PasswordScript.indexOf('\n\n', start);
  expect(end).toBeGreaterThan(start);
  return setup1PasswordScript.slice(start, end);
}

describe('agent/supabase の接続情報境界', () => {
  it('staging schema に Supabase の接続 field を置かない', () => {
    for (const field of SUPABASE_CONNECTION_FIELDS) {
      const matches = envSchema.filter(
        (entry) => entry.item === 'supabase' && entry.field === field,
      );
      expect(matches, field).toHaveLength(0);
    }
  });

  it('production schema には同じ接続 field を残す', () => {
    for (const field of SUPABASE_CONNECTION_FIELDS) {
      const matches = productionEnvSchema.filter(
        (entry) => entry.vault === 'human' && entry.item === 'supabase',
      );
      expect(
        matches.map((entry) => entry.field),
        field,
      ).toContain(field);
    }
  });

  it('local injection 参照から Staging の Supabase 接続情報を外す', () => {
    for (const field of SUPABASE_CONNECTION_FIELDS) {
      expect(opEnvExample, field).not.toContain(`op://agent/supabase/${field}`);
    }
  });

  it('1Password bootstrap が Staging の supabase item に接続 field を作らない', () => {
    const block = stagingSupabaseItemBlock();
    // 切り出しが空振りすると not.toContain が素通りするため、残す field で掴めていることを先に示す
    expect(block).toContain("'CRON_SECRET[concealed]='");
    expect(block).not.toContain('human');
    for (const field of SUPABASE_CONNECTION_FIELDS) {
      expect(block, field).not.toContain(field);
    }
  });

  it('SUPABASE_ACCESS_TOKEN は production へ一本化し、staging には置かない（#1933）', () => {
    const matches = envSchema.filter(
      (entry) => entry.item === 'supabase' && entry.field === 'SUPABASE_ACCESS_TOKEN',
    );
    expect(matches).toHaveLength(0);

    // .op-env.agent.example は guard の vault allowlist（agent /
    // Local のみ）により production 参照を持てない。ここでは staging 参照が
    // 消えたことだけを見る（production 側への repoint はできないし、しない）。
    expect(opEnvExample).not.toContain('op://agent/supabase/SUPABASE_ACCESS_TOKEN');

    const block = stagingSupabaseItemBlock();
    expect(block).not.toContain('SUPABASE_ACCESS_TOKEN');

    // 2026-08-17 に human/supabase-cli へ専用 item として切り出した（#2127）
    const productionMatches = productionEnvSchema.filter(
      (entry) =>
        entry.vault === 'human' &&
        entry.item === 'supabase-cli' &&
        entry.field === 'SUPABASE_ACCESS_TOKEN',
    );
    expect(productionMatches.length).toBeGreaterThan(0);
  });

  it('dev script に 1Password 参照で Supabase へ繋ぐ経路が残っていない', () => {
    expect(devWithOpScript).not.toContain('SUPABASE_TARGET" == "op"');
    expect(devWithOpScript).toContain('DAYOPT_SUPABASE_TARGET は廃止されました');
  });

  it('禁止 field の実在検査が接続 4 field + SUPABASE_ACCESS_TOKEN を網羅する', () => {
    const covered = forbiddenFields
      .filter((entry) => entry.vault === 'agent' && entry.item === 'supabase')
      .map((entry) => entry.field);
    expect(covered.sort()).toEqual(
      [
        ...SUPABASE_CONNECTION_FIELDS,
        'SUPABASE_ACCESS_TOKEN',
        'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
      ].sort(),
    );
  });

  it('admin script 用の env 参照は Production を指し、Staging を経由しない', () => {
    for (const field of SUPABASE_CONNECTION_FIELDS) {
      expect(adminEnvExample, field).not.toContain(`op://agent/supabase/${field}`);
    }
    // 管理者運用は production 相手なので、参照先が Production であること自体を固定する
    expect(adminEnvExample).toContain(
      'SUPABASE_SECRET_KEY=op://human/supabase/SUPABASE_SECRET_KEY',
    );
    // .op-env.human は各自が作る実行用ファイルなので commit させない
    expect(gitignore).toMatch(/^\.op-env\.human$/mu);
  });
});
