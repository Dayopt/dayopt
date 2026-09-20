import { describe, expect, it } from 'vitest';

import type { JevAnnotation, JevAnswer } from './jev-adapter.ts';
import {
  computeCoverage,
  computeMetrics,
  computeStrata,
  type ShadowCase,
} from './jev-shadow-report.ts';
import type { ShadowTruth } from './jev-shadow-truth.ts';

function annotation(
  answers: Record<string, JevAnswer> | null,
  overrides: Partial<JevAnnotation> = {},
): JevAnnotation {
  return {
    schemaVersion: 1,
    status: 'evaluated',
    reasonCode: 'ok',
    modelId: 'typesafe-ai/jev',
    resolvedModelId: 'typesafe-ai/jev',
    questionSetId: 'shadow-e1-v1',
    cacheKey: 'key',
    stateSha256: 'sha',
    evaluatedAt: '2026-09-18T00:00:00Z',
    answers,
    usage: { inputTokens: 100, outputTokens: 10 },
    latencyMs: 400,
    credits: { before: null, after: null },
    costUsd: 0.000013,
    coverage: {
      stateChars: 10,
      inputBytes: 20,
      totalInputBytes: 30,
      questionCount: 8,
      truncated: false,
    },
    providerMetadata: null,
    failure: null,
    ...overrides,
  };
}

function score(value: number): JevAnswer {
  return {
    type: 'score',
    score: value,
    probabilities: null,
    confidence: 0.6,
    topProbability: null,
  };
}

function lane(choice: string): JevAnswer {
  return { type: 'choice', choice, probabilities: null, confidence: 0.6, topProbability: null };
}

function bool(value: boolean): JevAnswer {
  return {
    type: 'boolean',
    probability: value ? 0.9 : 0.1,
    confidence: null,
    topProbability: null,
  };
}

function truth(overrides: Partial<ShadowTruth> = {}): ShadowTruth {
  return {
    protectedCategories: [],
    timeInvariant: false,
    reviewFull: false,
    codexP1: 0,
    codexP2: 0,
    fixRounds: 0,
    fixRoundsReason: 'counted',
    readySource: 'event',
    localized: true,
    areas: ['scripts/lib'],
    deepReviewNeeded: false,
    narrow: true,
    authorizationTruth: false,
    publicContractTruth: false,
    ...overrides,
  };
}

function shadowCase(overrides: Partial<ShadowCase> = {}): ShadowCase {
  return {
    id: 'pr-1',
    prNumber: 1,
    split: 'tune',
    stateSource: 'pr',
    collectionStatus: 'ready',
    truth: truth(),
    annotation: annotation({ lane: lane('standard') }),
    ...overrides,
  };
}

describe('Go 条件の指標', () => {
  it('深いレビューが要った変更を routine と答えた件数を数える', () => {
    const metrics = computeMetrics([
      shadowCase({
        id: 'pr-under',
        truth: truth({ deepReviewNeeded: true, protectedCategories: ['auth-mcp'], narrow: false }),
        annotation: annotation({ lane: lane('routine') }),
      }),
      shadowCase({
        id: 'pr-ok',
        truth: truth({ deepReviewNeeded: true, protectedCategories: ['billing'], narrow: false }),
        annotation: annotation({ lane: lane('frontier') }),
      }),
    ]);
    expect(metrics.underRouting).toMatchObject({ count: 1, denominator: 2, cases: ['pr-under'] });
  });

  it('保護対象なのに観点 boolean が全て false の場合も低リスク回答として数える', () => {
    const metrics = computeMetrics([
      shadowCase({
        id: 'pr-low',
        truth: truth({ deepReviewNeeded: true, protectedCategories: ['billing'], narrow: false }),
        annotation: annotation({
          lane: lane('standard'),
          reviewAuthorization: bool(false),
          reviewTimeInvariant: bool(false),
          reviewPublicContract: bool(false),
        }),
      }),
    ]);
    expect(metrics.lowRiskButProtected).toMatchObject({ count: 1, denominator: 1 });
  });

  it('狭い作業を frontier と答えた件数を数える', () => {
    const metrics = computeMetrics([
      shadowCase({ id: 'pr-over', annotation: annotation({ lane: lane('frontier') }) }),
    ]);
    expect(metrics.overEscalation).toMatchObject({ count: 1, denominator: 1 });
  });

  it('正解が unknown の case は一致率の分母に入れない', () => {
    const metrics = computeMetrics([
      shadowCase({
        truth: truth({ timeInvariant: null, localized: null }),
        annotation: annotation({ lane: lane('standard'), reviewTimeInvariant: bool(true) }),
      }),
    ]);
    expect(metrics.agreement.reviewTimeInvariant).toBeUndefined();
  });

  it('一致率を観点ごとに出す', () => {
    const metrics = computeMetrics([
      shadowCase({
        truth: truth({ timeInvariant: true }),
        annotation: annotation({ lane: lane('standard'), reviewTimeInvariant: bool(true) }),
      }),
      shadowCase({
        id: 'pr-2',
        truth: truth({ timeInvariant: true }),
        annotation: annotation({ lane: lane('standard'), reviewTimeInvariant: bool(false) }),
      }),
    ]);
    expect(metrics.agreement.reviewTimeInvariant).toEqual({ agreed: 1, denominator: 2 });
  });

  it('未評価・abstain・利用不可を混ぜない', () => {
    const metrics = computeMetrics([
      shadowCase({ id: 'a', annotation: null }),
      shadowCase({
        id: 'b',
        annotation: annotation(null, { status: 'abstained', reasonCode: 'input_too_large' }),
      }),
      shadowCase({
        id: 'c',
        annotation: annotation(null, { status: 'unavailable', reasonCode: 'rate_limited' }),
      }),
      shadowCase({ id: 'd' }),
    ]);
    expect(metrics).toMatchObject({ notEvaluated: 1, abstained: 1, unavailable: 1, evaluated: 1 });
  });

  it('実費は provider の値を合算する', () => {
    const metrics = computeMetrics([shadowCase(), shadowCase({ id: 'pr-2' })]);
    expect(metrics.costUsd).toBeCloseTo(0.000026, 9);
  });
});

describe('score は加重平均で返る', () => {
  // 2026-09-18 の live pilot で実測: evidenceSufficiency が 0.06 / 1.79 / 1.95、
  // ambiguity が 1.04 / 1.73 / 0.35。離散の段ではなく分布の確率加重平均。
  it('最も近い段へ丸めて分布を数える', () => {
    const score = (value: number): JevAnswer => ({
      type: 'score',
      score: value,
      probabilities: null,
      confidence: 0.9,
      topProbability: null,
    });
    const metrics = computeMetrics([
      shadowCase({
        id: 'a',
        annotation: annotation({ lane: lane('standard'), evidenceSufficiency: score(1.79) }),
      }),
      shadowCase({
        id: 'b',
        annotation: annotation({ lane: lane('standard'), evidenceSufficiency: score(1.95) }),
      }),
      shadowCase({
        id: 'c',
        annotation: annotation({ lane: lane('standard'), evidenceSufficiency: score(0.06) }),
      }),
    ]);
    expect(metrics.scoreDistribution.evidenceSufficiency).toEqual({ '0': 1, '2': 2 });
  });
});

describe('層別', () => {
  it('split と state 由来で分ける', () => {
    const strata = computeStrata([
      shadowCase({ id: 'a', split: 'tune', stateSource: 'issue' }),
      shadowCase({ id: 'b', split: 'holdout', stateSource: 'pr' }),
      shadowCase({ id: 'c', split: 'tune', stateSource: 'synthetic', truth: null }),
    ]);
    expect(strata.bySplit.tune?.total).toBe(2);
    expect(strata.bySplit.holdout?.total).toBe(1);
    expect(strata.byStateSource.synthetic?.total).toBe(1);
  });

  it('証拠が足りている層だけで Go 条件を読めるようにする', () => {
    // 証拠が無い case の lane を argmax で採ると過少振り分けに数えられる。
    // 床を超えた層では、同じ母集団でもゼロになることを固定する。
    const underRouted = truth({
      deepReviewNeeded: true,
      protectedCategories: ['auth-mcp'],
      narrow: false,
    });
    const strata = computeStrata([
      shadowCase({
        id: 'pr-no-evidence',
        truth: underRouted,
        annotation: annotation({ lane: lane('routine'), evidenceSufficiency: score(0.04) }),
      }),
      shadowCase({
        id: 'pr-with-evidence',
        truth: underRouted,
        annotation: annotation({ lane: lane('frontier'), evidenceSufficiency: score(1.9) }),
      }),
    ]);
    const sufficient = strata.byEvidence['evidenceSufficiency >= 0.5'];
    const insufficient = strata.byEvidence['evidenceSufficiency < 0.5（証拠不足・未評価）'];
    expect(sufficient?.underRouting).toMatchObject({ count: 0, denominator: 1 });
    expect(insufficient?.underRouting).toMatchObject({ count: 1, denominator: 1 });
    expect(strata.overall.underRouting.count).toBe(1);
  });

  it('evidenceSufficiency を答えていない注釈は証拠不足側へ置く', () => {
    const strata = computeStrata([
      shadowCase({ id: 'pr-none', annotation: null }),
      shadowCase({ id: 'pr-no-score', annotation: annotation({ lane: lane('standard') }) }),
    ]);
    expect(strata.byEvidence['evidenceSufficiency < 0.5（証拠不足・未評価）']?.total).toBe(2);
    expect(strata.byEvidence['evidenceSufficiency >= 0.5']).toBeUndefined();
  });
});

describe('母集団の層別件数', () => {
  it('必須層がゼロなら警告する', () => {
    const coverage = computeCoverage([shadowCase()]);
    expect(coverage.warnings.length).toBeGreaterThan(0);
    expect(coverage.warnings.join('\n')).toContain('protected');
  });

  it('揃っていれば警告しない', () => {
    const coverage = computeCoverage([
      shadowCase({ id: 'a', truth: truth({ protectedCategories: ['billing'] }) }),
      shadowCase({ id: 'b', truth: truth({ reviewFull: true }) }),
      shadowCase({ id: 'c', truth: truth({ codexP1: 1 }) }),
      shadowCase({ id: 'd', truth: truth({ fixRounds: 3 }) }),
      shadowCase({ id: 'e', truth: truth({ timeInvariant: true }) }),
      shadowCase({ id: 'f', stateSource: 'synthetic', truth: null }),
    ]);
    expect(coverage.warnings).toEqual([]);
  });

  it('変更 file 未取得と保護対象なしを混ぜない', () => {
    const coverage = computeCoverage([
      shadowCase({ id: 'a', truth: truth({ protectedCategories: null }) }),
      shadowCase({ id: 'b', truth: truth({ protectedCategories: [] }) }),
    ]);
    expect(coverage).toMatchObject({ filesIncomplete: 1, protected: 0 });
  });

  it('入力上限超過を数える', () => {
    const coverage = computeCoverage([shadowCase({ collectionStatus: 'input_too_large' })]);
    expect(coverage.inputTooLarge).toBe(1);
  });
});
