import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

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

describe('jev:smoke の引数検証', () => {
  it.each([
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
