import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseSmokeArgs } from './smoke.ts';

const rootDir = resolve(import.meta.dirname, '../../..');

/**
 * 引数の検証だけを確かめる。credential を渡さずに実行し、外部呼び出しへ進まないことを
 * exit code と文言で固定する。**live 呼び出しは含めない。**
 */
function runSmoke(args: string[]) {
  const { AI_GATEWAY_API_KEY: _omitted, ...env } = process.env;
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/tasks/jev/smoke.ts', ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    env,
  });
}

describe('parseSmokeArgs は未知の引数を無視しない', () => {
  it.each([
    ['打ち間違えた flag', ['--cas', 'minimal']],
    ['未知の option', ['--verbose']],
    ['余分な positional', ['minimal']],
    ['値の無い --case', ['--case']],
    ['空文字の --delay', ['--delay', '']],
  ])('%s は ok にしない', (_label, argv) => {
    expect(parseSmokeArgs(argv).ok).toBe(false);
  });

  it('既定値は安全側（間隔あり・全件）', () => {
    const parsed = parseSmokeArgs([]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.delayMs).toBeGreaterThan(0);
      expect(parsed.args.caseId).toBeNull();
    }
  });

  it('正しい引数は解釈する', () => {
    const parsed = parseSmokeArgs(['--case', 'minimal', '--delay', '1500', '--json']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args).toEqual({ caseId: 'minimal', delayMs: 1500, asJson: true });
  });
});

describe('jev:smoke の引数検証', () => {
  it.each([
    ['--case の打ち間違い（全件送信へ化ける形）', ['--cas', 'minimal']],
    ['未知の option', ['--verbose']],
    ['余分な positional', ['minimal']],
    ['--case に値が無い', ['--case']],
    ['--case の次が別の flag', ['--case', '--json']],
    ['--case が空文字（env 未設定の展開）', ['--case', '']],
    ['--delay に値が無い', ['--delay']],
    ['--delay が空文字（env 未設定の展開）', ['--delay', '']],
    ['--delay が負値', ['--delay', '-5']],
    ['--delay が数値でない', ['--delay', 'soon']],
    ['存在しないケース名', ['--case', 'nope']],
  ])('%s なら外部呼び出し前に落ちる', (_label, args) => {
    const result = runSmoke(args);

    expect(result.status).toBe(1);
    // credential の不足ではなく使い方の誤りとして落ちること。認証の有無と独立に判定する
    expect(result.stderr).not.toContain('AI_GATEWAY_API_KEY');
  });

  it('引数が正しければ credential の不足として落ちる（検証の順序が逆転していない）', () => {
    const result = runSmoke(['--case', 'minimal', '--delay', '1000']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AI_GATEWAY_API_KEY');
  });
});
