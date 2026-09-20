import { describe, expect, it } from 'vitest';
import { evaluateWithJev, type JevAnnotation } from './jev-adapter.ts';
import {
  claimRequests,
  claimRow,
  claimsInputSchema,
  contextRequests,
  contextRows,
  rankContext,
  selectContextCandidates,
  type ContextInput,
} from './jev-assist-packs.ts';

const sha = 'a'.repeat(40);
const input: ContextInput = {
  number: 1,
  sha,
  title: '日境界の変更',
  body: '日境界の仕様を変更する',
  url: 'https://github.com/Dayopt/dayopt/issues/1',
  missing: [],
  candidates: Array.from({ length: 27 }, (_, index) => ({
    id: `c${index}`,
    text: index === 3 ? '日境界はUTCではなくユーザーのtimezoneで判断する' : '作業中です',
    url: `https://github.com/Dayopt/dayopt/issues/1#issuecomment-${index}`,
    updatedAt: `2026-09-${String(index + 1).padStart(2, '0')}`,
    kind: 'comment',
  })),
};

describe('判断材料の意味と参照を保存する', () => {
  it('24件を超えても対象Issue本文を選択対象から落とさない', () => {
    const candidates = [
      { id: 'issue-1', kind: 'issue' as const, text: '要求', url: input.url, updatedAt: '' },
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `new-${index}`,
        kind: 'comment' as const,
        text: '新しい進捗',
        url: input.url,
        updatedAt: `2026-09-${String(index + 1).padStart(2, '0')}`,
      })),
    ];
    const result = selectContextCandidates({ ...input, candidates });
    expect(result.selected).toHaveLength(24);
    expect(result.selected[0]?.id).toBe('issue-1');
    expect(result.omitted).toHaveLength(1);
  });

  it('最新24件を6件ずつに分け、古い制約も12問以下で候補に残す', () => {
    const batches = contextRequests(input);
    expect(batches).toHaveLength(4);
    expect(batches.flatMap((batch) => batch.candidates).map((item) => item.id)).toContain('c3');
    expect(batches.flatMap((batch) => batch.candidates).map((item) => item.id)).not.toContain('c2');
    expect(Object.keys(batches[0].request.questions)).toHaveLength(12);
    expect(contextRequests({ ...input, sha: 'b'.repeat(40) })[0].request.state).not.toEqual(
      batches[0].request.state,
    );
  });

  it('原文付きの古い制約を進捗より上に出し、未評価を低関連と扱わない', async () => {
    const candidates = [input.candidates[3], input.candidates[26]];
    const empty = await evaluateWithJev(contextRequests(input)[0].request, { disabled: true });
    const confidence = { confidence: null, topProbability: null };
    const annotation: JevAnnotation = {
      ...empty,
      status: 'evaluated',
      evaluatedAt: '2026-09-20',
      answers: {
        relevant_0: { ...confidence, type: 'boolean', probability: 0.95 },
        kind_0: { ...confidence, type: 'choice', choice: 'constraint', probabilities: null },
        relevant_1: { ...confidence, type: 'boolean', probability: 0.1 },
        kind_1: { ...confidence, type: 'choice', choice: 'status_only', probabilities: null },
      },
    };
    const rows = contextRows(candidates, { source: 'live', reason: 'ok', annotation });
    expect(rankContext(rows)[0]).toMatchObject({
      id: 'c3',
      text: candidates[0].text,
      url: candidates[0].url,
    });
    expect(
      rankContext(
        contextRows(candidates, { source: 'unavailable', reason: 'timeout', annotation: null }),
      ),
    ).toEqual([]);
  });

  it('欠損・SHA不一致は支持へ昇格させず、反証はそのまま出す', async () => {
    const claims = claimsInputSchema.parse({
      schemaVersion: 1,
      target: { number: 1, sha },
      claims: [{ id: 'c', text: '別ユーザーの取得は不可能', evidenceIds: ['e'] }],
      evidence: [{ id: 'e', kind: 'blob', path: 'test.ts', sha }],
    });
    const evidence = [
      { id: 'e', text: '成功系テストのみ', url: input.url, sha, missing: null, facts: {} },
    ];
    const result = claimRequests(claims, evidence)[0];
    const empty = await evaluateWithJev(result.request, { disabled: true });
    const annotation: JevAnnotation = {
      ...empty,
      status: 'evaluated',
      answers: {
        relation: {
          type: 'choice',
          choice: 'contradicted',
          probabilities: { contradicted: 1 },
          confidence: null,
          topProbability: null,
        },
      },
    };
    expect(
      claimRow(result.claim, evidence, [], { source: 'live', reason: 'ok', annotation }).relation,
    ).toBe('contradicted');
    expect(
      claimRow(result.claim, evidence, ['e'], { source: 'live', reason: 'ok', annotation })
        .relation,
    ).toBe('unknown');
    expect(claimRequests(claims, [{ ...evidence[0], sha: 'b'.repeat(40) }])[0].missing).toContain(
      'e:sha_mismatch',
    );
  });

  it.each(['../secret', '/tmp/secret', 'a/.env.local', '.op-env.agent', 'key.pem'])(
    '範囲外または秘密のpath %s を拒否する',
    (path) => {
      expect(
        claimsInputSchema.safeParse({
          schemaVersion: 1,
          target: { number: 1, sha },
          claims: [{ id: 'c', text: 'claim', evidenceIds: ['e'] }],
          evidence: [{ id: 'e', kind: 'blob', sha, path }],
        }).success,
      ).toBe(false);
    },
  );

  it('存在しない参照と任意の証拠本文を拒否する', () => {
    expect(
      claimsInputSchema.safeParse({
        schemaVersion: 1,
        target: { number: 1, sha },
        claims: [{ id: 'c', text: 'claim', evidenceIds: ['missing'] }],
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      claimsInputSchema.safeParse({
        schemaVersion: 1,
        target: { number: 1, sha },
        claims: [{ id: 'c', text: 'claim', evidenceIds: ['e'] }],
        evidence: [{ id: 'e', kind: 'blob', sha, path: 'test.ts', text: 'private log' }],
      }).success,
    ).toBe(false);
  });
});
