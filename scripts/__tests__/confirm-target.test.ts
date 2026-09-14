import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// 破壊的な production 操作の対象確認（2026-09-14、Secret / Credential 監査 P2-2）。
// 期待値は操作対象から導いた project ref で、打ち返しが一致しない限り何もしない。
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const confirmScript = join(rootDir, 'scripts/tasks/confirm-target.sh');
const REF = 'abcdefghijklmnopqrst';
const OTHER_REF = 'zyxwvutsrqponmlkjihg';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dayopt-confirm-target-'));
  dirs.push(dir);
  return dir;
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [confirmScript, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
}

describe('confirm-target.sh', () => {
  it('url: 打ち返しが無ければ止め、対象 ref を案内する', () => {
    const result = run(['url', `https://${REF}.supabase.co`, 'テスト操作']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`DAYOPT_CONFIRM_TARGET=${REF}`);
  });

  it('url: 別 project の ref を打ち返しても止める', () => {
    const result = run(['url', `https://${REF}.supabase.co`, 'テスト操作'], {
      DAYOPT_CONFIRM_TARGET: OTHER_REF,
    });
    expect(result.status).toBe(1);
  });

  it('url: 一致した時だけ通す', () => {
    const result = run(['url', `https://${REF}.supabase.co`, 'テスト操作'], {
      DAYOPT_CONFIRM_TARGET: REF,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[確認済み] テスト操作 → ${REF}`);
  });

  it('url: ref を導けない URL は確認値に関係なく止める', () => {
    const result = run(['url', 'http://127.0.0.1:54321', 'テスト操作'], {
      DAYOPT_CONFIRM_TARGET: '',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('特定できません');
  });

  it('linked: link されていなければ止め、link 先 ref と一致した時だけ通す', () => {
    const dir = tempDir();
    expect(run(['linked', dir, 'テスト操作'], { DAYOPT_CONFIRM_TARGET: REF }).status).toBe(1);

    mkdirSync(join(dir, '.temp'), { recursive: true });
    writeFileSync(join(dir, '.temp/project-ref'), `${REF}\n`);
    expect(run(['linked', dir, 'テスト操作'], { DAYOPT_CONFIRM_TARGET: OTHER_REF }).status).toBe(1);
    expect(run(['linked', dir, 'テスト操作'], { DAYOPT_CONFIRM_TARGET: REF }).status).toBe(0);
  });
});

describe('破壊的な production script は確認前にネットワークへ出ない', () => {
  // curl を記録だけする偽物に差し替え、確認が通らない限り 1 回も呼ばれないことを見る
  function fakeCurlEnv() {
    const bin = tempDir();
    const log = join(bin, 'curl.log');
    writeFileSync(join(bin, 'curl'), `#!/bin/bash\necho "$@" >> "${log}"\necho '{}'\n`);
    chmodSync(join(bin, 'curl'), 0o755);
    return { bin, log };
  }

  it('admin-delete-user.sh は打ち返しが無ければ lookup も DELETE もしない', () => {
    const { bin, log } = fakeCurlEnv();
    const result = spawnSync('bash', [join(rootDir, 'scripts/runbook/admin-delete-user.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        USER_EMAIL: 'someone@example.com',
        NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
        SUPABASE_SECRET_KEY: 'sb_secret_test-placeholder',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`DAYOPT_CONFIRM_TARGET=${REF}`);
    expect(existsSync(log)).toBe(false);
  });

  it('admin-delete-user.sh は打ち返しが一致すれば先へ進む（確認が経路を塞ぎきっていない）', () => {
    const { bin, log } = fakeCurlEnv();
    spawnSync('bash', [join(rootDir, 'scripts/runbook/admin-delete-user.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        USER_EMAIL: 'someone@example.com',
        NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
        SUPABASE_SECRET_KEY: 'sb_secret_test-placeholder',
        DAYOPT_CONFIRM_TARGET: REF,
      },
    });
    expect(readFileSync(log, 'utf8')).toContain('/auth/v1/admin/users');
  });

  it('admin-set-user-password.sh / enable-auth-hook.sh / seed-dev-data.sh / linked reset が確認を持つ', () => {
    const read = (path: string) => readFileSync(join(rootDir, path), 'utf8');
    const setPassword = read('scripts/runbook/admin-set-user-password.sh');
    expect(setPassword.indexOf('require_target_confirmation')).toBeGreaterThan(-1);
    expect(setPassword.indexOf('require_target_confirmation')).toBeLessThan(
      setPassword.indexOf('-X PUT'),
    );

    const hook = read('scripts/runbook/enable-auth-hook.sh');
    expect(hook.indexOf('require_target_confirmation')).toBeGreaterThan(-1);
    expect(hook.indexOf('require_target_confirmation')).toBeLessThan(hook.indexOf('-X PATCH'));

    const seed = read('scripts/tasks/seed-dev-data.sh');
    const linkedBranch = seed.slice(seed.indexOf('USE_LINKED_DB:-'), seed.indexOf('else'));
    expect(linkedBranch).toContain('require_target_confirmation');
    expect(seed).not.toContain('/tmp/seed_timeblocks.sql');

    const productPackage = JSON.parse(read('apps/product/package.json')) as {
      scripts: Record<string, string>;
    };
    expect(productPackage.scripts['db:reset-linked:unsafe']).toMatch(
      /^bash \.\.\/\.\.\/scripts\/tasks\/confirm-target\.sh linked .+ && /,
    );
  });
});
