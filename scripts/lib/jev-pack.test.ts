import { describe, expect, it } from 'vitest';

import { jevCacheKey, type JevAnnotation } from './jev-adapter.ts';
import { createShadowPack } from './jev-pack-shadow.ts';
import {
  buildPackRequest,
  decideCase,
  isFreshAnnotation,
  packQuestionSetId,
  type PackCase,
} from './jev-pack.ts';
import { SHADOW_QUESTION_SET_ID } from './jev-shadow-questions.ts';
import { buildShadowRequest, type ShadowState, type ShadowTruth } from './jev-shadow-truth.ts';

const shadowPack = createShadowPack({
  resolveGate: () => ({ required: false, auditContract: false }),
});

const fixtureState: ShadowState = {
  source: 'issue',
  title: '課金 webhook の再送を直す',
  body: '## やること\n- retry を 1 回に絞る',
  labels: ['area:billing'],
};

function annotation(overrides: Partial<JevAnnotation>): JevAnnotation {
  return {
    schemaVersion: 1,
    status: 'evaluated',
    reasonCode: 'ok',
    modelId: 'typesafe-ai/jev',
    resolvedModelId: null,
    questionSetId: SHADOW_QUESTION_SET_ID,
    cacheKey: 'k',
    stateSha256: 's',
    evaluatedAt: '2026-09-19T00:00:00Z',
    answers: null,
    usage: { inputTokens: null, outputTokens: null },
    latencyMs: null,
    credits: { before: null, after: null },
    costUsd: null,
    coverage: {
      stateChars: 0,
      inputBytes: 0,
      totalInputBytes: 0,
      questionCount: 0,
      truncated: false,
    },
    providerMetadata: null,
    failure: null,
    ...overrides,
  } as JevAnnotation;
}

describe('pack 0（shadow-e1）は Phase 1 と同じ request を作る', () => {
  it('questionSetId が SHADOW_QUESTION_SET_ID と一致する', () => {
    expect(packQuestionSetId(shadowPack)).toBe(SHADOW_QUESTION_SET_ID);
  });

  it('同じ state で cacheKey が一致する（課金済み注釈が失効しない）', () => {
    const viaPack = buildPackRequest(shadowPack, fixtureState as never);
    const viaShadow = buildShadowRequest(fixtureState);
    expect(jevCacheKey(viaPack)).toBe(jevCacheKey(viaShadow));
  });

  it('buildState は state を加工しない', () => {
    const built = shadowPack.buildState({
      number: 1,
      title: fixtureState.title,
      body: '',
      labels: [],
      closingIssues: [
        { number: 9, title: fixtureState.title, body: fixtureState.body, labels: ['area:billing'] },
      ],
    });
    expect(built.state).toEqual(fixtureState);
    expect(jevCacheKey(buildPackRequest(shadowPack, built.state))).toBe(
      jevCacheKey(buildShadowRequest(fixtureState)),
    );
  });
});

describe('decideCase', () => {
  const base: PackCase<Parameters<typeof shadowPack.buildState>[0], ShadowTruth> = {
    id: 'pr-1',
    packId: shadowPack.id,
    split: 'tune',
    collectionStatus: 'ready',
    facets: {},
    input: { number: 1, title: 't', body: 'b', labels: [], closingIssues: [] },
    state: fixtureState as never,
    droppedSections: [],
    truth: null,
    annotation: null,
    baseline: null,
    decision: null,
  };

  it('annotation が無ければ baseline へ落ちる', () => {
    const decided = decideCase(shadowPack, base);
    expect(decided.baseline?.picks).toEqual({ lane: 'standard' });
    expect(decided.decision?.source).toBe('baseline');
  });

  it('abstain した annotation も baseline へ落ちる', () => {
    const decided = decideCase(shadowPack, {
      ...base,
      annotation: annotation({ status: 'abstained', reasonCode: 'input_too_large' }),
    });
    expect(decided.decision?.source).toBe('baseline');
  });

  it('評価済みなら Jev の答えを picks にし、annotation は触らない', () => {
    const currentKey = jevCacheKey(buildPackRequest(shadowPack, base.state));
    const evaluated = annotation({
      cacheKey: currentKey,
      answers: {
        lane: {
          type: 'choice',
          choice: 'frontier',
          probabilities: { routine: 0.1, standard: 0.2, frontier: 0.7 },
          confidence: 0.6,
          topProbability: 0.7,
        },
        localized: { type: 'boolean', probability: 0.5, confidence: null, topProbability: null },
      },
    });
    const decided = decideCase(shadowPack, { ...base, annotation: evaluated });
    expect(decided.decision).toMatchObject({
      source: 'jev',
      picks: { lane: 'frontier', localized: true },
      uncertain: ['localized'],
    });
    expect(decided.annotation).toBe(evaluated);
    expect(decided.annotation?.cacheKey).toBe(currentKey);
  });

  it('cacheKey が現在の request と違う（stale な）注釈は policy へ渡さず、保存は残す', () => {
    const stale = annotation({
      cacheKey: 'old',
      answers: {
        lane: {
          type: 'choice',
          choice: 'frontier',
          probabilities: { routine: 0.1, standard: 0.2, frontier: 0.7 },
          confidence: 0.6,
          topProbability: 0.7,
        },
      },
    });
    expect(isFreshAnnotation(shadowPack, { state: base.state, annotation: stale })).toBe(false);
    const decided = decideCase(shadowPack, { ...base, annotation: stale });
    expect(decided.decision?.source).toBe('baseline');
    expect(decided.decision?.picks).toEqual({ lane: 'standard' });
    expect(decided.annotation).toBe(stale);
  });
});
