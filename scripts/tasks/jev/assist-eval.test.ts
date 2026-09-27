import { describe, expect, it } from 'vitest';
import { evaluateAssistDataset } from '../../lib/jev-assist-evaluation.ts';
import { evaluationTemplate } from './assist-eval.ts';

describe('評価ひな型は未確認で作る', () => {
  it('claimsは各15組・tune20/holdout40でGoにしない', () => {
    const data = evaluationTemplate('claim-support');
    expect(data.cases).toHaveLength(60);
    expect(data.cases.filter((item) => item.split === 'tune')).toHaveLength(20);
    expect(evaluateAssistDataset(data).verdict).toBe('NOT_GO');
    expect(data.cases.every((item) => item.review.reviewedBy === null && !item.complete)).toBe(
      true,
    );
  });
  it('contextは10/20に分け、人手の有用資料ラベル無しでは評価不能', () => {
    const data = evaluationTemplate('context-relevance');
    expect(data.cases).toHaveLength(30);
    expect(data.cases.filter((item) => item.split === 'holdout')).toHaveLength(20);
    expect(() => evaluateAssistDataset(data)).toThrow();
  });
});
