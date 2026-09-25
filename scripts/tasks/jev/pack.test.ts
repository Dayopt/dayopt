import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { jevStoreRoot } from '../../lib/jev-assist-store.ts';
import { PACK_IDS, PACK_STATUS } from '../../lib/jev-pack.ts';
import { mapSkills } from '../ctx.mjs';
import { parsePackArgs } from './pack.ts';

const repoRoot = join(import.meta.dirname, '../../..');

describe('引数は完全に解釈する', () => {
  it.each([
    [[], 'packId'],
    [['bogus', 'collect'], 'packId'],
    [['skill-suggestion'], 'subcommand'],
    [['skill-suggestion', 'bogus'], 'subcommand'],
    [['skill-suggestion', 'collect', '--unknown'], '未知の引数'],
    [['skill-suggestion', 'report', '--threshold', '2'], '--threshold'],
  ])('%j を usage error にする', (argv, expected) => {
    const parsed = parsePackArgs(argv as string[]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(expected);
  });

  it('既定の保存先は pack ごとに分かれ、evaluate の既定 split は tune', () => {
    const evaluate = parsePackArgs(['skill-suggestion', 'evaluate']);
    const report = parsePackArgs(['shadow-e1', 'report', '--threshold', '0.6']);
    expect(evaluate.ok && evaluate.args).toMatchObject({
      out: join(jevStoreRoot(repoRoot), 'packs', 'skill-suggestion'),
      split: 'tune',
    });
    expect(report.ok && report.args).toMatchObject({
      out: join(jevStoreRoot(repoRoot), 'packs', 'shadow-e1'),
      split: 'all',
      threshold: 0.6,
    });
    expect(PACK_IDS).toEqual(['shadow-e1', 'skill-suggestion']);
  });
});

describe('ctx.mjs の mapSkills は roster の skill を path から返す', () => {
  // truth の導出が依存する既存規則。ctx.mjs 側の規則が動いたら、ここで先に気づく。
  it('supabase / i18n / test を path から引く', () => {
    expect(mapSkills(['supabase/migrations/1.sql'], false)).toEqual(['supabase']);
    expect(mapSkills(['apps/product/messages/ja/auth.json'], false)).toEqual(['i18n']);
    expect(mapSkills(['scripts/lib/x.test.ts'], false)).toEqual(['test']);
    expect(mapSkills(['scripts/ci/gate.mjs'], false)).toEqual([]);
  });
});

describe('CLI として起動できる', () => {
  // `protected-path-gate.mjs` と `ctx.mjs` は top-level await を持つ。tsx が .ts を CJS へ
  // 落とすため、静的 import だと ERR_REQUIRE_ASYNC_MODULE で落ちる。vitest は ESM なので
  // unit test だけでは検出できない。実起動で固定する。
  it('未知の引数で usage error を返し、credential を要求しない', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/tasks/jev/pack.ts', '--bogus'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, AI_GATEWAY_API_KEY: '' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packId');
    expect(result.stderr).not.toContain('AI_GATEWAY_API_KEY');
  });

  it('report は保存先が空でも起動して集計を出す（動的 import が CJS で通る）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-pack-cli-'));
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/tasks/jev/pack.ts',
        'skill-suggestion',
        'report',
        '--out',
        dir,
        '--json',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      packId: 'skill-suggestion',
      questionSetId: 'skill-suggestion-v1',
    });
  });

  it('evaluate は無効な skill-suggestion を credential 確認前に止める', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/tasks/jev/pack.ts', 'skill-suggestion', 'evaluate'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, AI_GATEWAY_API_KEY: '' },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pack skill-suggestion は無効化されている');
    expect(result.stderr).toContain(PACK_STATUS['skill-suggestion'].reason ?? '');
    expect(result.stderr).not.toContain('AI_GATEWAY_API_KEY');
  });
});

/**
 * #2827 の不変条件「各 pack は独立して無効化・撤去できる」。`JEV_DISABLED=1` は
 * adapter 全体の kill switch なので、pack 単位で止める手段がこれとは別に要る。
 */
describe('無効化した pack は evaluate だけが止まる', () => {
  it('無効な pack は理由を持つ', () => {
    expect(PACK_STATUS['shadow-e1']).toMatchObject({ status: 'disabled' });
    expect(PACK_STATUS['shadow-e1'].reason?.trim()).toBeTruthy();
    expect(PACK_STATUS['skill-suggestion']).toMatchObject({ status: 'disabled' });
    expect(PACK_STATUS['skill-suggestion'].reason?.trim()).toBeTruthy();
    // status の付け忘れた pack を残さない
    expect(Object.keys(PACK_STATUS).sort()).toEqual([...PACK_IDS].sort());
  });

  it('evaluate は credential を持っていても送信前に止まる', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/tasks/jev/pack.ts', 'shadow-e1', 'evaluate'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        // key がある状態でも止まることを見る（止まる理由が「key が無い」ではない）
        env: { ...process.env, AI_GATEWAY_API_KEY: 'test-key-not-used' },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('無効化');
    expect(result.stderr).toContain(PACK_STATUS['shadow-e1'].reason ?? '');
  });

  it('旧 CLI（pnpm jev:shadow）からも迂回できない', () => {
    // `jev:shadow evaluate` は pack shadow-e1 と同じ質問セットを送る。入口が 2 つある
    // ことを理由に無効化が片方だけに効くと、docs が案内している旧コマンドで課金できる
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/tasks/jev/shadow.ts', 'evaluate'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, AI_GATEWAY_API_KEY: 'test-key-not-used' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('無効化');
    expect(result.stderr).toContain(PACK_STATUS['shadow-e1'].reason ?? '');
  });

  it('report は無効な pack でも読める（negative result を失わない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-pack-disabled-'));
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/tasks/jev/pack.ts', 'shadow-e1', 'report', '--out', dir, '--json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ packId: 'shadow-e1' });
  });
});
