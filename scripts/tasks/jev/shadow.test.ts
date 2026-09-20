import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveProtectedPathGate } from '../../ci/protected-path-gate.mjs';
import type { JevRawResult, JevRunner } from '../../lib/jev-adapter.ts';
import { listStoredCases, parseShadowArgs, runCollect, runEvaluate, runReport } from './shadow.ts';

const repoRoot = join(import.meta.dirname, '../../..');

function outDir(): string {
  return mkdtempSync(join(tmpdir(), 'jev-shadow-'));
}

function args(overrides: Partial<ReturnType<typeof baseArgs>> = {}) {
  return { ...baseArgs(), ...overrides };
}

function baseArgs() {
  const parsed = parseShadowArgs(['collect']);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.args;
}

describe('引数は完全に解釈する', () => {
  it.each([
    [[], 'subcommand'],
    [['bogus'], 'subcommand'],
    [['collect', '--unknown'], '未知の引数'],
    [['collect', '--limit'], '値がない'],
    [['collect', '--limit', ''], '値が空'],
    [['collect', '--limit', '-3'], '値がない'],
    [['evaluate', '--split', 'other'], '--split'],
    [['evaluate', '--delay', 'abc'], '0 以上'],
    [['collect', 'extra'], '未知の引数'],
  ])('%j を usage error にする', (argv, expected) => {
    const parsed = parseShadowArgs(argv as string[]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(expected);
  });

  it('evaluate の既定 split は tune、report は all', () => {
    const evaluate = parseShadowArgs(['evaluate']);
    const report = parseShadowArgs(['report']);
    expect(evaluate.ok && evaluate.args.split).toBe('tune');
    expect(report.ok && report.args.split).toBe('all');
  });

  it('値つき flag を解釈する', () => {
    const parsed = parseShadowArgs([
      'evaluate',
      '--out',
      'x',
      '--max',
      '5',
      '--delay',
      '0',
      '--json',
    ]);
    expect(parsed.ok && parsed.args).toMatchObject({ out: 'x', max: 5, delayMs: 0, asJson: true });
  });
});

const prNode = {
  number: 101,
  title: '課金 webhook を直す',
  body: '## 関連 Issue\nRefs #1\n## Review focus\nbilling\n',
  createdAt: '2026-09-01T00:00:00Z',
  mergedAt: '2026-09-02T00:00:00Z',
  changedFiles: 2,
  labels: { nodes: [{ name: 'review:full' }, { name: 'area:billing' }] },
  closingIssuesReferences: { nodes: [] },
  reviewThreads: {
    nodes: [
      {
        comments: {
          nodes: [{ author: { login: 'chatgpt-codex-connector' }, body: '![P1 Badge] x' }],
        },
      },
    ],
  },
  timelineItems: {
    nodes: [
      { __typename: 'ReadyForReviewEvent', createdAt: '2026-09-01T01:00:00Z' },
      { __typename: 'PullRequestCommit', commit: { committedDate: '2026-09-01T02:00:00Z' } },
    ],
  },
};

function fakeGraphql() {
  return () => ({
    data: {
      repository: {
        pullRequests: { pageInfo: { hasNextPage: false, endCursor: '' }, nodes: [prNode] },
      },
    },
  });
}

function fakeApi() {
  return () => [
    { filename: 'apps/product/src/lib/billing/plan.ts' },
    { filename: 'apps/product/src/features/timeblock/Panel.tsx' },
  ];
}

describe('collect', () => {
  it('正解ラベルと state を書き出し、合成 case を足す', async () => {
    const dir = outDir();
    const output = await runCollect({
      args: args({ out: dir, limit: 10 }),
      api: fakeApi(),
      graphql: fakeGraphql(),
      resolveGate: resolveProtectedPathGate as never,
      now: () => new Date('2026-09-18T00:00:00Z'),
      policyCheckout: () => 'abc123',
    });

    const stored = listStoredCases(dir);
    const pr = stored.find((item) => item.id === 'pr-101');
    expect(pr?.truth?.protectedCategories).toEqual(['billing']);
    expect(pr?.truth?.timeInvariant).toBe(true);
    expect(pr?.truth?.codexP1).toBe(1);
    expect(pr?.truth?.deepReviewNeeded).toBe(true);
    // 人間が書いた review 観点の答えは state へ入れない。
    expect(JSON.stringify(pr?.state)).not.toContain('Review focus');
    expect(JSON.stringify(pr?.state)).not.toContain('review:full');
    expect(stored.filter((item) => item.stateSource === 'synthetic')).toHaveLength(4);
    expect(output).toContain('policy checkout: abc123');

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ policyCheckout: 'abc123', limit: 10 });
  });

  it('再収集しても課金済みの注釈を消さない', async () => {
    const dir = outDir();
    const collect = () =>
      runCollect({
        args: args({ out: dir, limit: 10 }),
        api: fakeApi(),
        graphql: fakeGraphql(),
        resolveGate: resolveProtectedPathGate as never,
        now: () => new Date(),
        policyCheckout: () => 'sha',
      });
    await collect();
    const path = join(dir, 'cases', 'pr-101.json');
    const first = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      JSON.stringify({ ...first, annotation: { status: 'evaluated', cacheKey: 'k' } }),
    );
    await collect();
    expect(JSON.parse(readFileSync(path, 'utf8')).annotation).toMatchObject({
      status: 'evaluated',
    });
  });

  it('変更 file が上限を超える PR は path 由来の label を unknown にする', async () => {
    const dir = outDir();
    await runCollect({
      args: args({ out: dir, limit: 10 }),
      api: fakeApi(),
      graphql: () => ({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: '' },
              nodes: [{ ...prNode, changedFiles: 900 }],
            },
          },
        },
      }),
      resolveGate: resolveProtectedPathGate as never,
      now: () => new Date(),
      policyCheckout: () => 'sha',
    });
    const stored = listStoredCases(dir).find((item) => item.id === 'pr-101');
    expect(stored).toBeDefined();
    expect(stored?.truth?.protectedCategories).toBeNull();
    expect(stored?.truth?.timeInvariant).toBeNull();
  });
});

function storedCase(dir: string, id: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, 'cases'), { recursive: true });
  writeFileSync(
    join(dir, 'cases', `${id}.json`),
    JSON.stringify({
      id,
      prNumber: 1,
      split: 'tune',
      stateSource: 'pr',
      collectionStatus: 'ready',
      state: { source: 'pr', title: 't', body: 'b', labels: [] },
      truth: null,
      annotation: null,
      ...overrides,
    }),
  );
}

function runnerReturning(results: JevRawResult[]): { runner: JevRunner; calls: () => number } {
  let index = 0;
  return {
    calls: () => index,
    runner: {
      async evaluate() {
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        if (result instanceof Error) throw result;
        return result as JevRawResult;
      },
      async credits() {
        return { status: 'ok', credits: { balance: 4.9, totalUsed: 0.1 } };
      },
    },
  };
}

function okResult(): JevRawResult {
  return {
    answers: {
      lane: {
        type: 'choice',
        choice: 'standard',
        probabilities: { routine: 0.2, standard: 0.7, frontier: 0.1 },
      },
      evidenceSufficiency: {
        type: 'score',
        score: 2,
        probabilities: { '0': 0, '1': 0.02, '2': 0.98 },
      },
      ambiguity: { type: 'score', score: 1, probabilities: { '0': 0.2, '1': 0.6, '2': 0.2 } },
      architecturalImpact: { type: 'boolean', probability: 0.2 },
      localized: { type: 'boolean', probability: 0.8 },
      reviewAuthorization: { type: 'boolean', probability: 0.1 },
      reviewTimeInvariant: { type: 'boolean', probability: 0.1 },
      reviewPublicContract: { type: 'boolean', probability: 0.1 },
    },
    usage: { inputTokens: 500, outputTokens: 50 },
    response: { modelId: 'typesafe-ai/jev' },
    providerMetadata: { gateway: { cost: '0.000021' } },
  } as unknown as JevRawResult;
}

class HttpError extends Error {
  statusCode: number;
  constructor(status: number) {
    super(`http ${status}`);
    this.statusCode = status;
  }
}

describe('evaluate', () => {
  const noSleep = async () => {};

  it('評価済みで入力が同じ case を送り直さない', async () => {
    const dir = outDir();
    storedCase(dir, 'pr-1');
    const first = runnerReturning([okResult()]);
    await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune' }),
      jevOptions: { runner: first.runner },
      log: () => {},
      sleepImpl: noSleep,
    });
    expect(first.calls()).toBe(1);

    const second = runnerReturning([okResult()]);
    const logs: string[] = [];
    await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune' }),
      jevOptions: { runner: second.runner },
      log: (line) => logs.push(line),
      sleepImpl: noSleep,
    });
    expect(second.calls()).toBe(0);
    expect(logs.join('\n')).toContain('skip pr-1');
  });

  it('429 は待って同じ case を 1 回だけ送り直す', async () => {
    const dir = outDir();
    storedCase(dir, 'pr-1');
    const runner = runnerReturning([new HttpError(429) as never, okResult()]);
    const waits: number[] = [];
    const code = await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune', rateLimitWaitMs: 1234 }),
      jevOptions: { runner: runner.runner },
      log: () => {},
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    expect(runner.calls()).toBe(2);
    expect(waits).toContain(1234);
    expect(code).toBe(0);
    expect(listStoredCases(dir)[0]?.annotation?.status).toBe('evaluated');
  });

  it('同じ case で 2 回続けて 429 なら停止する', async () => {
    const dir = outDir();
    storedCase(dir, 'pr-1');
    storedCase(dir, 'pr-2');
    const runner = runnerReturning([new HttpError(429) as never]);
    const logs: string[] = [];
    const code = await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune' }),
      jevOptions: { runner: runner.runner },
      log: (line) => logs.push(line),
      sleepImpl: noSleep,
    });
    expect(runner.calls()).toBe(2);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('2 回連続');
  });

  it('残高が下限を割ったら送らずに止まる（credits は購入しない）', async () => {
    const dir = outDir();
    storedCase(dir, 'pr-1');
    storedCase(dir, 'pr-2');
    let evaluated = 0;
    const code = await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune' }),
      jevOptions: {
        runner: {
          async evaluate() {
            evaluated += 1;
            return okResult();
          },
          async credits() {
            return { status: 'ok', credits: { balance: 0.2, totalUsed: 4.8 } };
          },
        },
      },
      log: () => {},
      sleepImpl: noSleep,
    });
    expect(evaluated).toBe(0);
    expect(code).toBe(1);
  });

  it('--max で送信件数を止める', async () => {
    const dir = outDir();
    storedCase(dir, 'pr-1');
    storedCase(dir, 'pr-2');
    storedCase(dir, 'pr-3');
    const runner = runnerReturning([okResult()]);
    await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune', max: 2 }),
      jevOptions: { runner: runner.runner },
      log: () => {},
      sleepImpl: noSleep,
    });
    expect(runner.calls()).toBe(2);
  });

  it('入力上限超過の case は送らない', async () => {
    const dir = outDir();
    storedCase(dir, 'pr-1', { collectionStatus: 'input_too_large' });
    const runner = runnerReturning([okResult()]);
    await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune' }),
      jevOptions: { runner: runner.runner },
      log: () => {},
      sleepImpl: noSleep,
    });
    expect(runner.calls()).toBe(0);
  });

  it('split で対象を絞る', async () => {
    const dir = outDir();
    storedCase(dir, 'pr-1', { split: 'holdout' });
    const runner = runnerReturning([okResult()]);
    await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune' }),
      jevOptions: { runner: runner.runner },
      log: () => {},
      sleepImpl: noSleep,
    });
    expect(runner.calls()).toBe(0);
  });
});

describe('report', () => {
  it('保存済み case から集計を組み立てる', async () => {
    const dir = outDir();
    storedCase(dir, 'pr-1', {
      truth: {
        protectedCategories: ['billing'],
        timeInvariant: false,
        reviewFull: true,
        codexP1: 1,
        codexP2: 0,
        fixRounds: 2,
        fixRoundsReason: 'counted',
        readySource: 'event',
        localized: true,
        areas: ['x'],
        deepReviewNeeded: true,
        narrow: false,
        authorizationTruth: false,
        publicContractTruth: true,
      },
    });
    const runner = runnerReturning([okResult()]);
    await runEvaluate({
      args: args({ command: 'evaluate', out: dir, split: 'tune' }),
      jevOptions: { runner: runner.runner },
      log: () => {},
      sleepImpl: async () => {},
    });
    const output = runReport({ args: args({ command: 'report', out: dir, split: 'all' }) });
    expect(output).toContain('shadow 評価の集計');
    expect(output).toContain('過少振り分け');
    expect(output).toContain('lane 分布');
  });
});

describe('CLI として起動できる', () => {
  // `protected-path-gate.mjs` は top-level await を持つ。tsx が .ts を CJS へ落とすため、
  // 静的 import だと ERR_REQUIRE_ASYNC_MODULE で落ちる。vitest は ESM なので unit test
  // だけでは検出できない。実起動で固定する。
  it('未知の引数で usage error を返し、credential を要求しない', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/tasks/jev/shadow.ts', '--bogus'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, AI_GATEWAY_API_KEY: '' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('subcommand');
    expect(result.stderr).not.toContain('AI_GATEWAY_API_KEY');
  });

  it('report は保存先が空でも起動して集計を出す', () => {
    const dir = outDir();
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/tasks/jev/shadow.ts', 'report', '--out', dir, '--json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('coverage');
  });

  it('evaluate は pack shadow-e1 の無効化で課金前に止まる', () => {
    // この CLI が送るのは pack `shadow-e1` と同じ質問セットなので、pack の status に従う。
    // status の判定は credential の確認より**先**に来るため、key の有無に関わらず
    // ここで止まる（credential が無い時の停止は、有効な pack 側を pack.test.ts が見る）
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/tasks/jev/shadow.ts', 'evaluate'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, AI_GATEWAY_API_KEY: '' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('無効化');
  });
});
