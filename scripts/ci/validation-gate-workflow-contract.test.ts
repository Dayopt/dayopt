import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * validation-gate.yml（#2795）の信頼境界を YAML の形で固定する。
 *
 * この workflow は commit status を書く token を持つため、**PR 側のコード・依存・artifact を
 * 一切実行しない**ことが前提。ci-token-isolation.test.ts が守るのは ci.yml（PR コードを動かす
 * job に write を置かない）で、こちらは逆向き（write を持つ controller に PR コードを
 * 持ち込まない）の contract。
 */
const yaml = readFileSync(join(process.cwd(), '.github/workflows/validation-gate.yml'), 'utf8');
const code = yaml
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
const onBlock = code.slice(code.indexOf('\non:'), code.indexOf('\npermissions:'));

describe('validation-gate.yml の信頼境界', () => {
  it('default branch の定義でしか走らない workflow_run / status だけを使う', () => {
    expect(onBlock).toMatch(/^\s*workflow_run:/m);
    expect(onBlock).toMatch(/^\s*workflows:\s*\[CI\]\s*$/m);
    // status event も default branch 限定（GitHub docs）。Vercel の success だけを job の if で通す
    expect(onBlock).toMatch(/^\s*status:\s*$/m);
    // pending 以外の terminal state（success / failure / error）で再評価する。success だけだと
    // wait 上限後に失敗した Preview が pending のまま残る
    expect(code).toMatch(
      /github\.event\.state != 'pending' && startsWith\(github\.event\.context, 'Vercel – '\)/,
    );
    // workflow_dispatch は任意 ref の定義で走る（Codex review P2、PR #2804）。使わない。
    expect(onBlock).not.toMatch(/^\s*workflow_dispatch:/m);
    // deployment_status は deployment の commit（PR head）の workflow 定義で走る（PR #2804 で実測）。
    // statuses:write を持つ controller の trigger にすると PR 側の定義に token が渡る。
    expect(onBlock).not.toMatch(/^\s*deployment_status:/m);
    expect(onBlock).not.toMatch(/^\s*pull_request(_target)?:/m);
    expect(onBlock).not.toMatch(/^\s*push:/m);
  });

  it('checkout は default branch のまま（PR head を ref に指定しない）で資格情報を残さない', () => {
    const checkouts = [
      ...code.matchAll(/uses:\s*actions\/checkout@[^\n]*\n((?:[ ]{8,}[^\n]*\n)*)/g),
    ];
    expect(checkouts).toHaveLength(1);
    const withBlock = checkouts[0][1];
    expect(withBlock).not.toMatch(/^\s*ref:/m);
    expect(withBlock).toMatch(/persist-credentials:\s*false/);
  });

  it('依存 install・pnpm・composite setup を使わない（node 標準ライブラリと gh だけ）', () => {
    expect(code).not.toMatch(/uses:\s*\.\//);
    expect(code).not.toMatch(/(^|[\s;&|(])(pnpm|npm|npx|yarn|corepack)(\s|$)/m);
    expect(code).not.toMatch(/validation-plan\.json|download-artifact/);
  });

  it('write 権限は statuses だけで、job 単位に宣言する', () => {
    const jobPermissions = code.slice(
      code.indexOf('\n    permissions:'),
      code.indexOf('\n    steps:'),
    );
    const scopes = [...jobPermissions.matchAll(/^\s{6}([\w-]+):\s*(\w+)/gm)].map(
      ([, scope, level]) => [scope, level],
    );
    expect(scopes.filter(([, level]) => level === 'write').map(([scope]) => scope)).toEqual([
      'statuses',
    ]);
    expect(code).not.toMatch(/write-all/);
    expect(code.slice(0, code.indexOf('\njobs:'))).toMatch(/^permissions:\n\s+contents: read\s*$/m);
  });

  it('Preview の遅延は job 内の bounded wait で吸収し、timeout を超えない', () => {
    const wait = Number(code.match(/VALIDATION_WAIT_MINUTES:\s*'(\d+)'/)?.[1]);
    const timeout = Number(code.match(/timeout-minutes:\s*(\d+)/)?.[1]);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(timeout);
  });

  it('評価は scripts/ci/validation-gate.mjs だけを実行する', () => {
    const runs = [...code.matchAll(/^\s*(?:run:\s*)?node\s+([^\s]+)/gm)].map(
      ([, script]) => script,
    );
    expect(new Set(runs)).toEqual(new Set(['scripts/ci/validation-gate.mjs']));
  });
});
