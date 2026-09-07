import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHandoff, validateHandoff } from './factory-handoff.mjs';

const script = resolve('scripts/tasks/factory-handoff.mjs');
const context = {
  number: 123,
  kind: 'issue',
  header: { url: 'https://github.com/Dayopt/dayopt/issues/123', title: '例の動作を確認' },
  routing: { level: 'L2', ready: true },
};
let cwd: string;
function git(...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function ready() {
  const draft = createHandoff({ cwd, context, sources: ['example.ts'] });
  return {
    ...draft,
    status: 'ready',
    acceptance: '例の関数が 1 を返す',
    facts: [{ claim: '定数 1 を返す', path: 'example.ts', line: 1 }],
    verification: [
      { command: 'node --check example.ts', status: 'passed', exitCode: 0, output: 'exit 0' },
    ],
    nextAction: 'この実装を参考に変更範囲を判断する',
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'factory-handoff-'));
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(cwd, 'example.ts'), 'export function example() { return 1; }\n');
  git('add', 'example.ts');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('factory handoff', () => {
  it('draft を完了とせず、根拠を埋めた同じ source の資料を再利用できる', () => {
    expect(
      validateHandoff({
        cwd,
        context,
        handoff: createHandoff({ cwd, context, sources: ['example.ts'] }),
      }).status,
    ).toBe('invalid');
    expect(validateHandoff({ cwd, context, handoff: ready() }).status).toBe('ready');
  });

  it('未コミットの source 変更でも古い資料を検出する', () => {
    const handoff = ready();
    writeFileSync(join(cwd, 'example.ts'), 'export function example() { return 2; }\n');
    expect(validateHandoff({ cwd, context, handoff }).status).toBe('stale');
  });

  it('snapshot の編集と別の引き継ぎ先 URL を拒否する', () => {
    const handoff = ready();
    expect(
      validateHandoff({
        cwd,
        context,
        handoff: { ...handoff, issueUrl: 'https://example.test/wrong' },
      }).status,
    ).toBe('invalid');
    handoff.snapshot.sources[0]!.sha256 = '0'.repeat(64);
    expect(validateHandoff({ cwd, context, handoff }).status).toBe('invalid');
  });

  it('HEAD または ctx の変更を検出する', () => {
    const handoff = ready();
    expect(validateHandoff({ cwd, context: { ...context, number: 124 }, handoff }).status).toBe(
      'stale',
    );
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'next');
    expect(validateHandoff({ cwd, context, handoff }).status).toBe('stale');
  });

  it('PR の別 checkout からの資料生成を拒否する', () => {
    expect(() =>
      createHandoff({
        cwd,
        context: { ...context, kind: 'pr', header: { ...context.header, headSha: '0'.repeat(40) } },
        sources: ['example.ts'],
      }),
    ).toThrow('HEAD');
  });

  it('未収集ファイルと存在しない行への根拠を拒否する', () => {
    const handoff = ready();
    handoff.facts[0]!.path = 'unseen.ts';
    expect(validateHandoff({ cwd, context, handoff }).status).toBe('invalid');
    handoff.facts[0]!.path = 'example.ts';
    handoff.facts[0]!.line = 999;
    expect(validateHandoff({ cwd, context, handoff }).status).toBe('invalid');
  });

  it('末尾改行の有無にかかわらず、存在しない最終行を根拠にできない', () => {
    const withTrailingNewline = ready();
    withTrailingNewline.facts[0]!.line = 2;
    expect(validateHandoff({ cwd, context, handoff: withTrailingNewline }).status).toBe('invalid');

    writeFileSync(join(cwd, 'example.ts'), 'export function example() { return 1; }');
    git('add', 'example.ts');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'without trailing newline');
    const withoutTrailingNewline = ready();
    withoutTrailingNewline.facts[0]!.line = 2;
    expect(validateHandoff({ cwd, context, handoff: withoutTrailingNewline }).status).toBe(
      'invalid',
    );
  });

  it('空の source を根拠にできない', () => {
    writeFileSync(join(cwd, 'empty.ts'), '');
    git('add', 'empty.ts');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'empty source');
    const draft = createHandoff({ cwd, context, sources: ['empty.ts'] });
    const handoff = {
      ...draft,
      status: 'ready',
      acceptance: '空の source は根拠として使わない',
      facts: [{ claim: '存在しない根拠', path: 'empty.ts', line: 1 }],
      verification: [{ command: 'true', status: 'passed', exitCode: 0, output: 'exit 0' }],
      nextAction: '根拠のある source を選び直す',
    };
    expect(validateHandoff({ cwd, context, handoff }).status).toBe('invalid');
  });

  it('未知・検証失敗・未実行を ready と数えない', () => {
    const handoff = ready();
    expect(
      validateHandoff({ cwd, context, handoff: { ...handoff, unknowns: ['呼び出し元は未確認'] } })
        .status,
    ).toBe('partial');
    expect(
      validateHandoff({
        cwd,
        context,
        handoff: {
          ...handoff,
          verification: [
            { command: 'pnpm test', status: 'not-run', exitCode: null, output: '依存なし' },
          ],
        },
      }).status,
    ).toBe('partial');
    expect(
      validateHandoff({
        cwd,
        context,
        handoff: {
          ...handoff,
          verification: [
            { command: 'pnpm test', status: 'failed', exitCode: 1, output: 'assertion failed' },
          ],
        },
      }).status,
    ).toBe('partial');
    handoff.verification[0]!.exitCode = 1;
    expect(validateHandoff({ cwd, context, handoff }).status).toBe('invalid');
  });

  it('source の秘密ファイル・symlink・repo 外参照を拒否する', () => {
    // The prohibited file need not exist: reject its name before reading it.
    expect(() => createHandoff({ cwd, context, sources: ['.env.local'] })).toThrow('秘密');
    expect(() => createHandoff({ cwd, context, sources: ['.ENV.local'] })).toThrow('秘密');
    symlinkSync(join(cwd, '.env.local'), join(cwd, 'alias.ts'));
    expect(() => createHandoff({ cwd, context, sources: ['alias.ts'] })).toThrow();
    expect(() => createHandoff({ cwd, context, sources: ['../example.ts'] })).toThrow('相対パス');
    symlinkSync(script, join(cwd, 'outside.mjs'));
    expect(() => createHandoff({ cwd, context, sources: ['outside.mjs'] })).toThrow('repo 外');
  });

  it('CLI で作成→記入→検査でき、上書きと古い資料を非 0 exit にする', () => {
    const contextFile = join(cwd, 'context.json');
    const out = join(cwd, 'handoff.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
    const args = ['create', '--context', contextFile, '--source', 'example.ts', '--out', out];
    expect(run(...args).status).toBe(0);
    const draft = readFileSync(out, 'utf8');
    expect(run(...args).status).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe(draft);
    const validate = ['validate', '--context', contextFile, '--file', out];
    expect(run(...validate).status).toBe(1);
    writeFileSync(out, JSON.stringify(ready()));
    const checked = run(...validate);
    expect(checked.status).toBe(0);
    expect(JSON.parse(checked.stdout).status).toBe('ready');
    writeFileSync(join(cwd, 'example.ts'), 'changed\n');
    const stale = run(...validate);
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stdout).status).toBe('stale');
    expect(
      run('validate', '--context', contextFile, '--file', out, '--execute', 'true').status,
    ).toBe(1);
  });
});
