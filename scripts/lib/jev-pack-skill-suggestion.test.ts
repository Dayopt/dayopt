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
  it('file 未取得なら全部 null', () => {
    const truth = deriveSkillTruth(
      {
        filesComplete: false,
        attributable: true,
        files: [],
        diffSignals: { onMutate: true, clientMutation: true, errorHandling: true },
      },
      mapSkills,
      roster,
    );
    expect(Object.values(truth).every((value) => value === null)).toBe(true);
  });

  it('複数 issue を閉じる PR（帰属不能）なら全部 null', () => {
    const truth = deriveSkillTruth(
      {
        filesComplete: true,
        attributable: false,
        files: ['supabase/migrations/1.sql'],
        diffSignals: { onMutate: true, clientMutation: true, errorHandling: true },
      },
      mapSkills,
      roster,
    );
    expect(Object.values(truth).every((value) => value === null)).toBe(true);
  });

  it('mutation を足したのに onMutate を忘れた PR でも optimistic-update は true', () => {
    const truth = deriveSkillTruth(
      {
        filesComplete: true,
        attributable: true,
        files: ['apps/product/src/features/x/hooks.ts'],
        diffSignals: { onMutate: false, clientMutation: true, errorHandling: false },
      },
      mapSkills,
      roster,
    );
    expect(truth['optimistic-update']).toBe(true);
  });

  it('path 規則 + stores path + diff の印で決め、決められない skill は null', () => {
    const truth = deriveSkillTruth(
      {
        filesComplete: true,
        attributable: true,
        files: ['supabase/migrations/1.sql', 'apps/product/src/lib/stores/ui-store.ts'],
        diffSignals: { onMutate: true, clientMutation: false, errorHandling: false },
      },
      mapSkills,
      roster,
    );
    expect(truth).toMatchObject({
      supabase: true,
      'store-creating': true,
      'optimistic-update': true,
      'error-handling': false,
      test: false,
      'diagnosing-bugs': null,
      'react-performance': null,
    });
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
    expect(signals).toEqual({ onMutate: true, clientMutation: false, errorHandling: false });
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
    expect(signals).toEqual({ onMutate: false, clientMutation: true, errorHandling: true });
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
        files: ['a.ts'],
        diffSignals: { onMutate: true, clientMutation: false, errorHandling: false },
      },
      facets: { issueNumber: 42, prNumbers: '1,2', attributable: 1 },
    });
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
