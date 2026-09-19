import { describe, expect, it } from 'vitest';

import { validateJevRequest, type JevAnnotation } from './jev-adapter.ts';
import type { PrEvidence } from './jev-gh-prs.ts';
import {
  buildSkillQuestions,
  buildVocabulary,
  computeBaselines,
  computeSkillMetrics,
  createSkillSuggestionPack,
  deriveSkillTruth,
  detectExplicitMentions,
  detectKeywordMatches,
  extractDiffSignals,
  groupPrsByIssue,
  policyVersionFor,
  skillPolicy,
  type SkillSuggestionInput,
  type SkillSuggestionTruth,
} from './jev-pack-skill-suggestion.ts';
import { buildPackRequest, type PackCase, type PackDecision } from './jev-pack.ts';
import { SKILL_ROSTER_IDS, questionIdFor, type SkillDoc } from './jev-skill-roster.ts';

/** 12 skill ぶんの最小 roster。語彙は test で追いやすいよう短くする。 */
const roster: SkillDoc[] = SKILL_ROSTER_IDS.map((id) => ({
  id,
  description: `${id} の説明`,
  whenToUse: [`${id} を使う時`],
}));

function withVocabulary(id: SkillDoc['id'], bullets: string[]): SkillDoc[] {
  return roster.map((doc) => (doc.id === id ? { ...doc, whenToUse: bullets } : doc));
}

const mapSkills = (files: string[]): string[] => {
  const skills = new Set<string>();
  for (const file of files) {
    if (file.startsWith('supabase/migrations/')) skills.add('supabase');
    if (file.endsWith('.test.ts')) skills.add('test');
    if (file.startsWith('apps/product/messages/')) skills.add('i18n');
  }
  return [...skills];
};

function input(overrides: Partial<SkillSuggestionInput> = {}): SkillSuggestionInput {
  return {
    issueNumber: 10,
    title: 'title',
    body: 'body',
    labels: [],
    pathTokens: [],
    ...overrides,
  };
}

describe('questions', () => {
  it('skill ごとに boolean 1 問で、静的検査を通る', () => {
    const questions = buildSkillQuestions(roster);
    expect(Object.keys(questions)).toHaveLength(12);
    expect(questions[questionIdFor('supabase')]).toMatchObject({ type: 'boolean' });
    expect(questions[questionIdFor('supabase')]?.instructions).toContain('supabase を使う時');
    const errors = validateJevRequest(
      buildPackRequest(
        { id: 'skill-suggestion', questionVersion: 'v1', questions },
        { source: 'issue', title: 't', body: 'b', labels: [] },
      ),
    );
    expect(errors).toEqual([]);
  });
});

describe('B0: 明示された skill 名', () => {
  it('完全一致だけを拾う', () => {
    expect(detectExplicitMentions('関連 skill: trpc-router-creating を読む', roster)).toEqual([
      'trpc-router-creating',
    ]);
    expect(detectExplicitMentions('trpc-router を直す', roster)).toEqual([]);
    expect(detectExplicitMentions('`test` を足す', roster)).toEqual(['test']);
    expect(detectExplicitMentions('unit-test を足す', roster)).toEqual([]);
  });
});

describe('B1: 語彙の overlap', () => {
  it('2 語以上出た skill だけ当たり、共通語は落とす', () => {
    const docs = withVocabulary('supabase', [
      'migration ファイルを追加する時',
      'RLS ポリシーを編集する時',
    ]);
    const vocabulary = buildVocabulary(docs);
    expect(vocabulary.get('supabase')).toEqual(
      expect.arrayContaining(['migration', 'rls', 'ポリシー']),
    );
    expect(detectKeywordMatches('新しい migration と RLS を足す', vocabulary)).toEqual([
      'supabase',
    ]);
    expect(detectKeywordMatches('migration だけ', vocabulary)).toEqual([]);
  });

  it('多くの skill に共通する token は語彙から外れる', () => {
    const shared = roster.map((doc) => ({ ...doc, whenToUse: ['共通語彙 を使う時'] }));
    const vocabulary = buildVocabulary(shared);
    for (const tokens of vocabulary.values()) expect(tokens).not.toContain('共通語彙');
  });
});

describe('truth', () => {
  const evidence = (
    overrides: Partial<Parameters<typeof deriveSkillTruth>[0]> = {},
  ): Parameters<typeof deriveSkillTruth>[0] => ({
    filesComplete: true,
    attributable: true,
    patchComplete: true,
    statusComplete: true,
    files: [],
    addedFiles: [],
    diffSignals: {
      optimisticUpdate: false,
      errorHandling: false,
      trpcProcedure: false,
      authBoundary: false,
    },
    ...overrides,
  });

  it('file 未取得なら全部 null', () => {
    const truth = deriveSkillTruth(
      evidence({ filesComplete: false, files: ['supabase/migrations/1.sql'] }),
      roster,
    );
    expect(Object.values(truth).every((value) => value === null)).toBe(true);
  });

  it('複数 issue を閉じる PR（帰属不能）なら全部 null', () => {
    const truth = deriveSkillTruth(
      evidence({ attributable: false, files: ['supabase/migrations/1.sql'] }),
      roster,
    );
    expect(Object.values(truth).every((value) => value === null)).toBe(true);
  });

  it('patch が欠けていれば diff 由来の正解は null、path 由来は残る', () => {
    const truth = deriveSkillTruth(
      evidence({
        patchComplete: false,
        files: ['supabase/migrations/1.sql', 'apps/product/src/features/x/Panel.test.tsx'],
      }),
      roster,
    );
    expect(truth).toMatchObject({
      supabase: true,
      test: true,
      'optimistic-update': null,
      'error-handling': null,
      security: null,
      'trpc-router-creating': null,
    });
  });

  it('path 由来と diff 由来を表のとおりに決め、証明できない skill は null', () => {
    const truth = deriveSkillTruth(
      evidence({
        files: ['supabase/migrations/1.sql', 'apps/product/src/lib/stores/ui-store.ts'],
        addedFiles: ['apps/product/src/lib/stores/ui-store.ts'],
        diffSignals: {
          optimisticUpdate: true,
          errorHandling: false,
          trpcProcedure: false,
          authBoundary: false,
        },
      }),
      roster,
    );
    expect(truth).toMatchObject({
      supabase: true,
      'store-creating': true,
      'optimistic-update': true,
      'error-handling': false,
      security: false,
      test: false,
      'diagnosing-bugs': null,
      'react-performance': null,
    });
  });

  // ここが 4 巡目で設計を変えた理由。候補規則（`mapSkills`）は `server/` 配下の file すべてに
  // security を返すが、正解は認可の境界に触れた diff でしか true にしない。
  it('server 配下の test を直しただけでは security を true にしない', () => {
    const truth = deriveSkillTruth(
      evidence({ files: ['apps/product/src/features/foo/server/service.test.ts'] }),
      roster,
    );
    expect(truth.security).toBe(false);
    expect(truth['trpc-router-creating']).toBe(false);
    expect(truth.test).toBe(true);
    // 候補規則はこの path に security を返す（正解には使わないことの対比）。
    expect(mapSkills(['apps/product/src/features/foo/server/service.test.ts'])).toContain('test');
  });

  // 5 巡目の指摘。store-creating の発動条件は「新規 store を**追加**する時」なので、
  // 既存 store 配下の helper / test を直しただけでは true にしない。
  it('既存 store 配下の test を直しただけでは store-creating を true にしない', () => {
    const file = 'apps/product/src/features/auth/stores/resolve-user-id.test.ts';
    expect(deriveSkillTruth(evidence({ files: [file] }), roster)['store-creating']).toBe(false);
    // 追加された file でも test なら store の追加ではない。
    expect(
      deriveSkillTruth(evidence({ files: [file], addedFiles: [file] }), roster)['store-creating'],
    ).toBe(false);
    const store = 'apps/product/src/features/auth/stores/session-store.ts';
    expect(
      deriveSkillTruth(evidence({ files: [store], addedFiles: [store] }), roster)['store-creating'],
    ).toBe(true);
  });

  it('status が取れなければ addedPath 由来の正解は null', () => {
    const truth = deriveSkillTruth(
      evidence({
        statusComplete: false,
        files: ['apps/product/src/lib/stores/ui-store.ts', 'supabase/migrations/1.sql'],
      }),
      roster,
    );
    expect(truth['store-creating']).toBeNull();
    // path 由来（編集でも発動する skill）は残る。
    expect(truth.supabase).toBe(true);
  });

  it('認可の境界に触れた diff なら security は true', () => {
    const truth = deriveSkillTruth(
      evidence({
        files: ['apps/product/src/features/foo/server/router.ts'],
        diffSignals: {
          optimisticUpdate: false,
          errorHandling: false,
          trpcProcedure: true,
          authBoundary: true,
        },
      }),
      roster,
    );
    expect(truth).toMatchObject({ security: true, 'trpc-router-creating': true });
  });

  it('component を触っただけでは storybook を true にしない（.stories.tsx が発動条件）', () => {
    expect(
      deriveSkillTruth(evidence({ files: ['packages/components/src/Button.tsx'] }), roster)
        .storybook,
    ).toBe(false);
    expect(
      deriveSkillTruth(evidence({ files: ['packages/components/src/Button.stories.tsx'] }), roster)
        .storybook,
    ).toBe(true);
  });

  it('diff の印は追加行だけ見る', () => {
    const signals = extractDiffSignals([
      {
        filename: 'a.ts',
        previousFilename: null,
        patch: ' onMutate: old,\n-captureException(e)\n+const x = 1',
      },
      { filename: 'b.ts', previousFilename: null, patch: '+++ b/b.ts\n+  onMutate: () => {}' },
      { filename: 'c.bin', previousFilename: null, patch: null },
    ]);
    expect(signals).toMatchObject({ optimisticUpdate: true, errorHandling: false });
  });

  it('useMutation の追加と try / catch / onError の追加も印にする', () => {
    const signals = extractDiffSignals([
      {
        filename: 'a.tsx',
        previousFilename: null,
        patch: '+const create = trpc.plans.create.useMutation({\n+  onError: () => toast(),\n+});',
      },
      { filename: 'b.ts', previousFilename: null, patch: '+  } catch (error) {' },
    ]);
    expect(signals).toMatchObject({ optimisticUpdate: true, errorHandling: true });
  });
});

describe('groupPrsByIssue', () => {
  function pr(overrides: Partial<PrEvidence>): PrEvidence {
    return {
      number: 1,
      title: 'pr',
      body: '',
      labels: [],
      createdAt: '2026-09-01T00:00:00Z',
      mergedAt: null,
      changedFiles: 1,
      filesComplete: true,
      files: [],
      reviewThreads: [],
      timeline: [],
      closingIssues: [],
      closingIssuesComplete: true,
      ...overrides,
    };
  }

  it('同じ issue を閉じる PR を束ね、issue の無い PR を捨てる', () => {
    const issue = {
      number: 42,
      title: 'i18n を直す',
      body: '<!-- hidden -->\n`apps/product/messages/ja/auth.json` を直す',
      labels: ['status:ready', 'area:i18n'],
    };
    const cases = groupPrsByIssue(
      [
        pr({
          number: 1,
          closingIssues: [issue],
          files: [{ filename: 'a.ts', previousFilename: null, patch: '+onMutate' }],
        }),
        pr({ number: 2, closingIssues: [issue], filesComplete: false }),
        pr({ number: 3 }),
      ],
      (path) => path.endsWith('.json'),
    );
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      id: 'issue-42',
      input: {
        issueNumber: 42,
        body: '`apps/product/messages/ja/auth.json` を直す',
        labels: ['area:i18n'],
        pathTokens: ['apps/product/messages/ja/auth.json'],
      },
      evidence: {
        filesComplete: false,
        attributable: true,
        patchComplete: true,
        statusComplete: false,
        files: ['a.ts'],
        diffSignals: { optimisticUpdate: true, errorHandling: false },
      },
      facets: {
        issueNumber: 42,
        prNumbers: '1,2',
        attributable: 1,
        patchComplete: 1,
        statusComplete: 0,
      },
    });
  });

  it('PR が新設した path は着手時に無かったものとして rule から外し、削除した path は残す', () => {
    const issue = {
      number: 43,
      title: 't',
      body: '`apps/new/router.ts` を作り `apps/old/legacy.ts` を消す。`apps/keep/x.ts` は触らない',
      labels: [],
    };
    const cases = groupPrsByIssue(
      [
        pr({
          number: 1,
          closingIssues: [issue],
          files: [
            {
              filename: 'apps/new/router.ts',
              previousFilename: null,
              patch: '+x',
              status: 'added',
            },
            {
              filename: 'apps/old/legacy.ts',
              previousFilename: null,
              patch: '-x',
              status: 'removed',
            },
          ],
        }),
      ],
      (path) => path !== 'apps/old/legacy.ts',
    );
    expect(cases[0]?.input.pathTokens).toEqual(['apps/old/legacy.ts', 'apps/keep/x.ts']);
    // status が読めた PR では、追加 file（renamed の新名を含む）を evidence に持つ。
    expect(cases[0]?.evidence).toMatchObject({
      statusComplete: true,
      addedFiles: ['apps/new/router.ts'],
    });
  });

  it('patch が欠けた file があれば patchComplete を false にし、closing issue が取り切れていなければ帰属不能', () => {
    const issue = { number: 44, title: 't', body: 'b', labels: [] };
    const cases = groupPrsByIssue(
      [
        pr({
          number: 1,
          closingIssues: [issue],
          closingIssuesComplete: false,
          files: [{ filename: 'big.ts', previousFilename: null, patch: null }],
        }),
      ],
      () => false,
    );
    expect(cases[0]?.evidence).toMatchObject({ attributable: false, patchComplete: false });
  });

  it('複数 issue を閉じる PR は全 issue を候補にし、正解は帰属不能にする', () => {
    const first = { number: 7, title: 'a', body: 'a', labels: [] };
    const second = { number: 8, title: 'b', body: 'b', labels: [] };
    const cases = groupPrsByIssue(
      [
        pr({ number: 1, closingIssues: [first, second] }),
        pr({ number: 2, closingIssues: [second] }),
      ],
      () => false,
    );
    expect(cases.map((item) => item.id).sort()).toEqual(['issue-7', 'issue-8']);
    for (const item of cases) {
      expect(item.evidence.attributable).toBe(false);
      expect(item.facets.attributable).toBe(0);
    }
  });
});

function annotationWith(probabilities: Partial<Record<SkillDoc['id'], number>>): JevAnnotation {
  const answers: NonNullable<JevAnnotation['answers']> = {};
  for (const doc of roster)
    answers[questionIdFor(doc.id)] = {
      type: 'boolean',
      probability: probabilities[doc.id] ?? 0.05,
      confidence: null,
      topProbability: null,
    };
  return {
    schemaVersion: 1,
    status: 'evaluated',
    reasonCode: 'ok',
    modelId: 'typesafe-ai/jev',
    resolvedModelId: null,
    questionSetId: 'skill-suggestion-v1',
    cacheKey: 'k',
    stateSha256: 's',
    evaluatedAt: '2026-09-19T00:00:00Z',
    answers,
    usage: { inputTokens: null, outputTokens: null },
    latencyMs: null,
    credits: { before: null, after: null },
    costUsd: null,
    coverage: {
      stateChars: 0,
      inputBytes: 0,
      totalInputBytes: 0,
      questionCount: 12,
      truncated: false,
    },
    providerMetadata: null,
    failure: null,
  } as JevAnnotation;
}

describe('policy', () => {
  const deps = { roster, mapSkills, threshold: 0.6 };
  const baseline: PackDecision = {
    policyVersion: policyVersionFor(0.6),
    source: 'baseline',
    picks: { i18n: true },
    uncertain: [],
  };

  it('閾値以上を採り、帯を不確かにし、rule は残す', () => {
    const decision = skillPolicy(
      annotationWith({ supabase: 0.9, storybook: 0.5, i18n: 0.1 }),
      input({ pathTokens: ['apps/product/messages/ja/auth.json'] }),
      baseline,
      deps,
    );
    expect(decision.source).toBe('jev');
    expect(decision.picks).toMatchObject({
      supabase: true,
      storybook: false,
      i18n: true,
      test: false,
    });
    expect(decision.uncertain).toEqual(['storybook']);
    expect(decision.policyVersion).toBe('v1;theta=0.6');
  });

  it('評価できていなければ baseline を返す', () => {
    expect(skillPolicy(null, input(), baseline, deps)).toBe(baseline);
    expect(skillPolicy(null, null, null, deps).picks).toEqual({});
  });
});

describe('baseline と metrics', () => {
  it('baseline は rule ∪ B1', () => {
    const docs = withVocabulary('supabase', ['migration を足す時', 'RLS を直す時']);
    const baselines = computeBaselines(
      input({ body: 'migration と RLS を直す。test skill も読む', pathTokens: ['x.test.ts'] }),
      { roster: docs, mapSkills },
    );
    expect(baselines).toEqual({ b0: ['test'], b1: ['supabase'], rule: ['test'] });
  });

  it('labels も baseline の材料にする（Jev の state と同じ入力）', () => {
    const docs = withVocabulary('i18n', ['messages を編集する時', '翻訳 キーを足す時']);
    const baselines = computeBaselines(
      input({ body: '文言を直す', labels: ['area:i18n', 'kind:messages'] }),
      { roster: docs, mapSkills },
    );
    // `area:i18n` は skill 名の明示（B0）として扱う。
    expect(baselines.b0).toEqual(['i18n']);
    expect(baselines.b1).toEqual(['i18n']);
  });

  it('B0 の対と null の truth を分母から外し、jev と baseline を同じ対で数える', () => {
    const truth = (values: Partial<SkillSuggestionTruth>): SkillSuggestionTruth => {
      const result = {} as SkillSuggestionTruth;
      for (const doc of roster) result[doc.id] = null;
      return { ...result, ...values };
    };
    const decision = (picks: Record<string, boolean>, uncertain: string[] = []): PackDecision => ({
      policyVersion: 'v1;theta=0.5',
      source: 'jev',
      picks,
      uncertain,
    });
    const baselineOf = (picks: Record<string, boolean>): PackDecision => ({
      policyVersion: 'v1;theta=0.5',
      source: 'baseline',
      picks,
      uncertain: [],
    });
    const item = (
      id: string,
      body: string,
      t: SkillSuggestionTruth,
      d: PackDecision | null,
      b: PackDecision,
    ): PackCase<SkillSuggestionInput, SkillSuggestionTruth> => ({
      id,
      packId: 'skill-suggestion',
      split: 'tune',
      collectionStatus: 'ready',
      facets: {},
      input: input({ body }),
      state: {},
      droppedSections: [],
      truth: t,
      annotation: null,
      baseline: b,
      decision: d,
    });

    const cases = [
      // supabase: jev 当たり / baseline 外れ。test は B0 で明示されているので対に入らない。
      item(
        'issue-1',
        'test skill を読む',
        truth({ supabase: true, test: true }),
        decision({ supabase: true, test: true }, ['supabase']),
        baselineOf({}),
      ),
      // supabase: jev 空振り（fp）、baseline 正しく false。
      item(
        'issue-2',
        'x',
        truth({ supabase: false, test: false }),
        decision({ supabase: true }),
        baselineOf({}),
      ),
      // decision が baseline 由来の case は対象外。
      item(
        'issue-3',
        'x',
        truth({ supabase: true }),
        baselineOf({ supabase: true }),
        baselineOf({}),
      ),
      // 正解が全部 null（帰属不能）の case は、Jev が答えていても母数に入らない。
      item('issue-4', 'x', truth({}), decision({ supabase: true }), baselineOf({})),
    ];
    const summary = computeSkillMetrics(cases, roster);
    expect(summary.eligibleCases).toBe(2);
    const supabase = summary.rows.find((row) => row.skill === 'supabase');
    expect(supabase).toMatchObject({
      pairs: 2,
      positives: 1,
      uncertain: 1,
      jev: { tp: 1, fp: 1, fn: 0, tn: 0, precision: 0.5, recall: 1 },
      baseline: { tp: 0, fp: 0, fn: 1, tn: 1, precision: null, recall: 0 },
    });
    const test = summary.rows.find((row) => row.skill === 'test');
    expect(test).toMatchObject({ pairs: 1, positives: 0 });
    expect(summary.rows.find((row) => row.skill === 'diagnosing-bugs')?.pairs).toBe(0);
    expect(summary.macroF1.jev).toBeCloseTo(2 / 3);
    // 正例があるのに真陽性ゼロの skill は F1 = 0 として分母に残る（null で消えない）。
    expect(supabase?.baseline.f1).toBe(0);
    expect(summary.macroF1.baseline).toBe(0);
  });
});

describe('createSkillSuggestionPack', () => {
  it('state は title / body / labels だけで、pathTokens も正解も入れない', () => {
    const pack = createSkillSuggestionPack({ roster, mapSkills, pathExists: () => true });
    const built = pack.buildState(input({ pathTokens: ['secret/path.ts'], labels: ['area:x'] }));
    expect(built.state).toEqual({
      source: 'issue',
      title: 'title',
      body: 'body',
      labels: ['area:x'],
    });
    expect(JSON.stringify(built.state)).not.toContain('secret/path.ts');
    expect(pack.policyVersion).toBe('v1;theta=0.5');
    expect(Object.keys(pack.questions)).toHaveLength(12);
  });
});
