import { describe, expect, it } from 'vitest';
import { evaluateAssistDataset, macroF1 } from './jev-assist-evaluation.ts';

const review = {
  reviewedBy: 'human-fixture',
  rationale: '原文と照合したテストfixture',
  sourceRefs: ['https://github.com/Dayopt/dayopt/issues/1'],
};
const labels = ['supported', 'contradicted', 'mixed', 'unknown'] as const;
function claims() {
  return {
    schemaVersion: 1,
    packId: 'claim-support',
    questionVersion: 'v1',
    frozenAt: '2026-09-20T00:00:00Z',
    cases: labels.flatMap((expected) =>
      Array.from({ length: 15 }, (_, i) => ({
        id: `${expected}-${i}`,
        split: i < 5 ? 'tune' : 'holdout',
        review,
        complete: true,
        expected,
        predicted: expected,
        baseline: 'unknown',
      })),
    ),
  };
}

describe('Go候補は事前登録した条件を全て満たす時だけ', () => {
  it('空・未確認・未完走をGoにしない', () => {
    expect(evaluateAssistDataset({ ...claims(), cases: [] }).verdict).toBe('NOT_GO');
    const data = claims();
    expect(
      evaluateAssistDataset({
        ...data,
        cases: data.cases.map((item) => ({ ...item, review: { ...review, reviewedBy: null } })),
      }).verdict,
    ).toBe('NOT_GO');
    data.cases[6].complete = false;
    expect(evaluateAssistDataset(data).verdict).toBe('NOT_GO');
  });
  it('高いF1でも反証を支持とした場合は停止する', () => {
    const data = claims();
    expect(evaluateAssistDataset(data).verdict).toBe('GO_CANDIDATE');
    data.cases[20].predicted = 'supported';
    expect(evaluateAssistDataset(data).verdict).toBe('NOT_GO');
  });
  it('未評価を分母から落としてF1を上げない', () => {
    expect(macroF1(labels.map((expected) => ({ expected, predicted: expected })))).toBe(1);
    expect(macroF1(labels.map((expected) => ({ expected, predicted: null })))).toBe(0);
  });
  it('Recallの平均が上がっても必須制約を落とせば停止する', () => {
    const data = {
      schemaVersion: 1,
      packId: 'context-relevance',
      questionVersion: 'v1',
      frozenAt: '2026-09-20T00:00:00Z',
      cases: Array.from({ length: 30 }, (_, i) => ({
        id: `issue-${i}`,
        split: i < 10 ? 'tune' : 'holdout',
        review,
        complete: true,
        candidateIds: ['a', 'b', 'c'],
        usefulIds: ['a', 'b'],
        requiredIds: ['a'],
        jevTop5: ['a', 'b'],
        recencyTop5: ['a', 'c'],
        keywordTop5: ['c'],
      })),
    };
    expect(evaluateAssistDataset(data).verdict).toBe('GO_CANDIDATE');
    data.cases[12].jevTop5 = ['b'];
    expect(evaluateAssistDataset(data).verdict).toBe('NOT_GO');
  });
});
