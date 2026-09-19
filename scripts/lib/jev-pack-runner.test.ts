import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  jevCacheKey,
  type JevAnnotation,
  type JevRawResult,
  type JevRunner,
} from './jev-adapter.ts';
import {
  computeAnnotationStats,
  listCases,
  parseRunnerFlags,
  runEvaluateLoop,
  runPackCollect,
  runPackEvaluate,
  runPackReport,
  writeCase,
  type RunnerFlags,
} from './jev-pack-runner.ts';
import {
  createSkillSuggestionPack,
  type SkillSuggestionInput,
  type SkillSuggestionTruth,
} from './jev-pack-skill-suggestion.ts';
import { buildPackRequest, type PackCase } from './jev-pack.ts';
import { SKILL_ROSTER_IDS, questionIdFor, type SkillDoc } from './jev-skill-roster.ts';

function outDir(): string {
  return mkdtempSync(join(tmpdir(), 'jev-pack-'));
}

const defaults: RunnerFlags = {
  out: 'x',
  limit: 100,
  max: null,
  split: 'all',
  delayMs: 0,
  rateLimitWaitMs: 0,
  threshold: null,
  asJson: false,
};

describe('parseRunnerFlags', () => {
  it.each([
    [['--unknown'], '未知の引数'],
    [['--limit'], '値がない'],
    [['--limit', ''], '値が空'],
    [['--limit', '-3'], '値がない'],
    [['--split', 'other'], '--split'],
    [['--delay', 'abc'], '0 以上'],
    [['--threshold', '1.5'], '--threshold'],
    [['extra'], '未知の引数'],
  ])('%j を usage error にする', (argv, expected) => {
    const parsed = parseRunnerFlags(argv, defaults);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(expected);
  });

  it('値つき flag を解釈する', () => {
    const parsed = parseRunnerFlags(
      ['--out', 'y', '--max', '5', '--delay', '0', '--threshold', '0.6', '--json'],
      defaults,
    );
    expect(parsed.ok && parsed.flags).toMatchObject({
      out: 'y',
      max: 5,
      delayMs: 0,
      threshold: 0.6,
      asJson: true,
    });
  });
});

// --- fakes ------------------------------------------------------------------------

const roster: SkillDoc[] = SKILL_ROSTER_IDS.map((id) => ({
  id,
  description: `${id} の説明`,
  whenToUse: [`${id} を使う時`],
}));

const mapSkills = (files: string[]): string[] => {
  const skills = new Set<string>();
  for (const file of files) {
    if (file.startsWith('supabase/migrations/')) skills.add('supabase');
    if (file.endsWith('.test.ts')) skills.add('test');
  }
  return [...skills];
};

function pack(threshold: number | null = null) {
  return createSkillSuggestionPack({
    roster,
    mapSkills,
    threshold,
    pathExists: (path) => path.endsWith('.test.ts'),
  });
}

function okResult(probabilities: Partial<Record<SkillDoc['id'], number>> = {}): JevRawResult {
  const answers: Record<string, unknown> = {};
  for (const doc of roster)
    answers[questionIdFor(doc.id)] = {
      type: 'boolean',
      probability: probabilities[doc.id] ?? 0.05,
    };
  return {
    answers,
    usage: { inputTokens: 500, outputTokens: 50 },
    response: { modelId: 'typesafe-ai/jev' },
    providerMetadata: { gateway: { cost: '0.000021' } },
  };
}

class HttpError extends Error {
  statusCode: number;
  constructor(status: number) {
    super(`http ${status}`);
    this.statusCode = status;
  }
}

function runnerReturning(
  results: (JevRawResult | Error)[],
  balance = 4.9,
): { runner: JevRunner; calls: () => number } {
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
        return { status: 'ok', credits: { balance, totalUsed: 0.1 } };
      },
    },
  };
}

const issue = {
  number: 42,
  title: 'migration を足す',
  body: '`scripts/lib/jev-adapter.test.ts` を直す\n\n## やること\n- RLS を追加',
  labels: { nodes: [{ name: 'status:ready' }, { name: 'area:db' }] },
};

function prNode(number: number, closing = true) {
  return {
    number,
    title: `pr ${number}`,
    body: '## Review focus\nRLS',
    createdAt: '2026-09-01T00:00:00Z',
    mergedAt: '2026-09-02T00:00:00Z',
    changedFiles: 2,
    labels: { nodes: [{ name: 'review:full' }] },
    closingIssuesReferences: { nodes: closing ? [issue] : [] },
    reviewThreads: { nodes: [] },
    timelineItems: { nodes: [] },
  };
}

function fakeGraphql(nodes: ReturnType<typeof prNode>[]) {
  return () => ({
    data: {
      repository: {
        pullRequests: { pageInfo: { hasNextPage: false, endCursor: '' }, nodes },
      },
    },
  });
}

function fakeApi() {
  return () => [
    { filename: 'supabase/migrations/1.sql', patch: '+create table x' },
    { filename: 'apps/product/src/features/x/hooks.ts', patch: '+  onMutate: () => {}' },
  ];
}

type SkillCase = PackCase<SkillSuggestionInput, SkillSuggestionTruth>;

async function collect(dir: string, nodes = [prNode(1), prNode(2, false)]) {
  return runPackCollect({
    pack: pack(),
    out: dir,
    limit: 10,
    api: fakeApi(),
    graphql: fakeGraphql(nodes),
    now: () => new Date('2026-09-19T00:00:00Z'),
    policyCheckout: () => 'abc123',
  });
}

// --- runEvaluateLoop --------------------------------------------------------------

describe('runEvaluateLoop', () => {
  const request = buildPackRequest(pack(), { source: 'issue', title: 't', body: 'b', labels: [] });
  const noSleep = async () => {};

  function target(annotation: JevAnnotation | null = null) {
    return { id: 'issue-1', annotation };
  }

  it('評価済みで cacheKey が同じ case を送り直さない', async () => {
    const first = runnerReturning([okResult()]);
    let stored: JevAnnotation | null = null;
    await runEvaluateLoop({
      targets: [target()],
      requestOf: () => request,
      persist: (_item, annotation) => {
        stored = annotation;
      },
      max: null,
      delayMs: 0,
      rateLimitWaitMs: 0,
      jevOptions: { runner: first.runner },
      sleepImpl: noSleep,
    });
    expect(first.calls()).toBe(1);
    expect(stored).not.toBeNull();
    expect((stored as unknown as JevAnnotation).cacheKey).toBe(jevCacheKey(request));

    const second = runnerReturning([okResult()]);
    const logs: string[] = [];
    await runEvaluateLoop({
      targets: [target(stored)],
      requestOf: () => request,
      persist: () => {},
      max: null,
      delayMs: 0,
      rateLimitWaitMs: 0,
      jevOptions: { runner: second.runner },
      log: (line) => logs.push(line),
      sleepImpl: noSleep,
    });
    expect(second.calls()).toBe(0);
    expect(logs.join('\n')).toContain('skip issue-1');
  });

  it('429 は待って同じ case を 1 回だけ送り直す', async () => {
    const runner = runnerReturning([new HttpError(429), okResult()]);
    const waits: number[] = [];
    const result = await runEvaluateLoop({
      targets: [target()],
      requestOf: () => request,
      persist: () => {},
      max: null,
      delayMs: 0,
      rateLimitWaitMs: 1234,
      jevOptions: { runner: runner.runner },
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    expect(runner.calls()).toBe(2);
    expect(waits).toContain(1234);
    expect(result).toEqual({ sent: 1, stopped: false });
  });

  it('同じ case で 2 回続けて 429 なら停止する', async () => {
    const runner = runnerReturning([new HttpError(429)]);
    const logs: string[] = [];
    const result = await runEvaluateLoop({
      targets: [target(), { id: 'issue-2', annotation: null }],
      requestOf: () => request,
      persist: () => {},
      max: null,
      delayMs: 0,
      rateLimitWaitMs: 0,
      jevOptions: { runner: runner.runner },
      log: (line) => logs.push(line),
      sleepImpl: noSleep,
    });
    expect(runner.calls()).toBe(2);
    expect(result.stopped).toBe(true);
    expect(logs.join('\n')).toContain('2 回連続');
  });

  it('残高が下限を割ったら送らずに止まる（credits は購入しない）', async () => {
    const runner = runnerReturning([okResult()], 0.5);
    const result = await runEvaluateLoop({
      targets: [target(), { id: 'issue-2', annotation: null }],
      requestOf: () => request,
      persist: () => {},
      max: null,
      delayMs: 0,
      rateLimitWaitMs: 0,
      jevOptions: { runner: runner.runner },
      sleepImpl: noSleep,
    });
    expect(runner.calls()).toBe(0);
    expect(result).toEqual({ sent: 1, stopped: true });
  });

  it('--max で送信件数を止め、送信の間だけ delay を挟む', async () => {
    const runner = runnerReturning([okResult()]);
    const waits: number[] = [];
    const result = await runEvaluateLoop({
      targets: [target(), { id: 'issue-2', annotation: null }, { id: 'issue-3', annotation: null }],
      requestOf: () => request,
      persist: () => {},
      max: 2,
      delayMs: 77,
      rateLimitWaitMs: 0,
      jevOptions: { runner: runner.runner },
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result.sent).toBe(2);
    expect(waits).toEqual([77]);
  });
});

// --- collect / evaluate / report ------------------------------------------------------

describe('runPackCollect', () => {
  it('issue 単位の case を書き、正解・baseline・decision を持ち、evidence は保存しない', async () => {
    const dir = outDir();
    const output = await collect(dir);
    expect(output).toContain('policy checkout: abc123');

    const cases = listCases<SkillCase>(dir);
    expect(cases.map((item) => item.id)).toEqual(['issue-42']);
    const item = cases[0];
    expect(item).toMatchObject({
      packId: 'skill-suggestion',
      collectionStatus: 'ready',
      facets: { issueNumber: 42, prNumbers: '1' },
      input: { pathTokens: ['scripts/lib/jev-adapter.test.ts'], labels: ['area:db'] },
      truth: { supabase: true, 'optimistic-update': true, test: false, 'diagnosing-bugs': null },
      baseline: { source: 'baseline', picks: { test: true } },
      decision: { source: 'baseline' },
    });
    const raw = readFileSync(join(dir, 'cases', 'issue-42.json'), 'utf8');
    expect(raw).not.toContain('patch');
    expect(raw).not.toContain('create table');
    // 人間が書いた review 観点も正解 label も state へ入れない。
    expect(JSON.stringify(item?.state)).not.toContain('Review focus');
    expect(JSON.stringify(item?.state)).not.toContain('status:ready');

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      packId: 'skill-suggestion',
      questionSetId: 'skill-suggestion-v1',
      counts: { total: 1, withTruth: 1 },
    });
  });

  it('旧形式の保存先（legacyOut）から同じ id の注釈を引き継ぐ', async () => {
    const legacy = outDir();
    const dir = outDir();
    // `pnpm jev:shadow` が書く StoredCase の形。pack runner の PackCase とは違う。
    writeCase(legacy, {
      id: 'issue-42',
      prNumber: 42,
      split: 'tune',
      annotation: { status: 'evaluated', cacheKey: 'legacy' } as unknown as JevAnnotation,
    });
    await runPackCollect({
      pack: pack(),
      out: dir,
      limit: 10,
      api: fakeApi(),
      graphql: fakeGraphql([prNode(1)]),
      now: () => new Date('2026-09-19T00:00:00Z'),
      policyCheckout: () => 'abc123',
      legacyOut: legacy,
    });
    const item = listCases<SkillCase>(dir)[0];
    expect(item?.annotation?.cacheKey).toBe('legacy');
    // 引き継いだだけで、現在の request と合わない注釈は Decision には使わない。
    expect(item?.decision?.source).toBe('baseline');
  });

  it('再収集しても課金済みの注釈を消さない', async () => {
    const dir = outDir();
    await collect(dir);
    const runner = runnerReturning([okResult({ supabase: 0.9 })]);
    await runPackEvaluate({
      pack: pack(),
      out: dir,
      split: 'all',
      max: null,
      delayMs: 0,
      rateLimitWaitMs: 0,
      jevOptions: { runner: runner.runner },
      log: () => {},
      sleepImpl: async () => {},
    });
    await collect(dir);
    const item = listCases<SkillCase>(dir)[0];
    expect(item?.annotation?.status).toBe('evaluated');
    expect(item?.decision).toMatchObject({ source: 'jev', picks: { supabase: true, test: true } });
  });
});

describe('runPackEvaluate と runPackReport', () => {
  it('評価すると decision が Jev 由来になり、report は閾値を変えても注釈を再利用する', async () => {
    const dir = outDir();
    await collect(dir);
    const runner = runnerReturning([okResult({ supabase: 0.55, i18n: 0.9 })]);
    const code = await runPackEvaluate({
      pack: pack(),
      out: dir,
      split: 'tune',
      max: null,
      delayMs: 0,
      rateLimitWaitMs: 0,
      jevOptions: { runner: runner.runner },
      log: () => {},
      sleepImpl: async () => {},
    });
    // split は issue 番号 hash で決まる。tune でなければ送っていない。
    const stored = listCases<SkillCase>(dir)[0];
    if (stored?.split !== 'tune') {
      expect(runner.calls()).toBe(0);
      return;
    }
    expect(code).toBe(0);
    expect(stored.decision).toMatchObject({
      source: 'jev',
      picks: { supabase: true, i18n: true, test: true },
      uncertain: ['supabase'],
    });

    const markdown = runPackReport({ pack: pack(0.7), out: dir, split: 'all' });
    expect(markdown).toContain('policy v1;theta=0.7');
    expect(markdown).toContain('| supabase |');
    const rethresholded = listCases<SkillCase>(dir)[0];
    expect(rethresholded?.decision?.picks).toMatchObject({ supabase: false, i18n: true });
    expect(rethresholded?.annotation?.cacheKey).toBe(stored.annotation?.cacheKey);
    expect(runner.calls()).toBe(1);

    const json = JSON.parse(runPackReport({ pack: pack(), out: dir, split: 'all', asJson: true }));
    expect(json).toMatchObject({ packId: 'skill-suggestion', stats: { evaluated: 1, stale: 0 } });
  });

  it('case が無ければ evaluate は送らずに 1 を返す', async () => {
    const dir = outDir();
    const runner = runnerReturning([okResult()]);
    const code = await runPackEvaluate({
      pack: pack(),
      out: dir,
      split: 'all',
      max: null,
      delayMs: 0,
      rateLimitWaitMs: 0,
      jevOptions: { runner: runner.runner },
      log: () => {},
    });
    expect(code).toBe(1);
    expect(runner.calls()).toBe(0);
  });
});

describe('computeAnnotationStats', () => {
  it('cacheKey が現在の request と違う注釈を stale に数える', () => {
    const p = pack();
    const state = { source: 'issue', title: 't', body: 'b', labels: [] };
    const item = (cacheKey: string): SkillCase => ({
      id: 'issue-1',
      packId: p.id,
      split: 'tune',
      collectionStatus: 'ready',
      facets: {},
      input: null,
      state,
      droppedSections: [],
      truth: null,
      annotation: {
        status: 'evaluated',
        cacheKey,
        costUsd: 0.001,
        latencyMs: 500,
      } as unknown as JevAnnotation,
      baseline: null,
      decision: null,
    });
    const stats = computeAnnotationStats(p, [
      item(jevCacheKey(buildPackRequest(p, state))),
      item('old'),
    ]);
    expect(stats).toMatchObject({ evaluated: 2, stale: 1, costUsd: 0.002 });
    expect(stats.latencyMs.p50).toBe(500);
  });
});
