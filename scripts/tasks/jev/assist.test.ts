import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluateWithJev, type JevRequest } from '../../lib/jev-adapter.ts';
import { claimsInputSchema, type ContextInput } from '../../lib/jev-assist-packs.ts';
import {
  assistClaims,
  assistContext,
  formatAssist,
  parseAssistArgs,
  readClaimsInput,
} from './assist.ts';

const sha = 'a'.repeat(40);
const temporary = () => mkdtempSync(join(tmpdir(), 'dayopt-jev-cli-'));

describe('assist CLI', () => {
  it.each(
    [
      [],
      ['context'],
      ['claims', '--issue', '1'],
      ['context', '--issue', '1x'],
      ['context', '--issue', '1', '--oops'],
      ['context', '--issue', '1', '--issue', '2'],
    ].map((args) => ({ args })),
  )('引数 $args を送信前に拒否する', ({ args }) => expect(() => parseAssistArgs(args)).toThrow());
  it('cache-onlyは明示的にAPI評価を止める', () =>
    expect(parseAssistArgs(['context', '--issue', '1', '--cache-only', '--json'])).toEqual({
      mode: 'context',
      issue: 1,
      json: true,
      cacheOnly: true,
    }));
  it('envへ向いた入力symlinkを開かない', () => {
    const dir = temporary();
    writeFileSync(join(dir, '.env.local'), 'do not read');
    symlinkSync(join(dir, '.env.local'), join(dir, 'input.json'));
    expect(() => readClaimsInput(join(dir, 'input.json'))).toThrow();
  });
  it('実CLIの引数エラーでkeyや入力内容を出力しない', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/tasks/jev/assist.ts', '--bogus'], {
      encoding: 'utf8',
      env: { ...process.env, AI_GATEWAY_API_KEY: '' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('引数');
    expect(result.stderr).not.toContain('authorization');
  });
});

describe('推定を主担当用の成果物にする', () => {
  it('欠損証拠はモデルを呼ばず、判断不能と参照を出す', async () => {
    const input = claimsInputSchema.parse({
      schemaVersion: 1,
      target: { number: 1, sha },
      claims: [{ id: 'c', text: '安全', evidenceIds: ['e'] }],
      evidence: [{ id: 'e', kind: 'blob', path: 'test.ts', sha }],
    });
    const evaluate = vi.fn(evaluateWithJev);
    const report = await assistClaims(
      {
        input,
        evidence: [
          {
            id: 'e',
            text: '',
            url: 'https://github.com/Dayopt/dayopt/blob/main/test.ts',
            sha,
            missing: 'source_unavailable',
            facts: {},
          },
        ],
      },
      { root: temporary(), allowNetwork: true, evaluate },
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(report.rows[0]).toMatchObject({
      relation: 'unknown',
      missing: ['e'],
      reason: 'missing_evidence',
    });
    expect(formatAssist(report, '/tmp/result.json')).toContain('判断不能');
  });
  it('24候補は待たず部分評価し、再実行で次の6件を処理する', async () => {
    const input: ContextInput = {
      number: 1,
      sha,
      title: 'title',
      body: 'body',
      url: 'https://github.com/Dayopt/dayopt/issues/1',
      missing: [],
      candidates: Array.from({ length: 25 }, (_, index) => ({
        id: `c${index}`,
        text: 'context',
        url: `https://github.com/Dayopt/dayopt/issues/1#issuecomment-${index}`,
        kind: 'comment',
        updatedAt: String(index).padStart(2, '0'),
      })),
    };
    const evaluate = vi.fn(async (request: JevRequest) => {
      const empty = await evaluateWithJev(request, { disabled: true });
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          key.startsWith('relevant')
            ? { type: 'boolean' as const, probability: 0.9, confidence: null, topProbability: null }
            : {
                type: 'choice' as const,
                choice: 'constraint',
                probabilities: null,
                confidence: null,
                topProbability: null,
              },
        ]),
      );
      return { ...empty, status: 'evaluated' as const, reasonCode: 'ok' as const, answers };
    });
    const options = { root: temporary(), allowNetwork: true, credentialAvailable: true, evaluate };
    const first = await assistContext(input, { ...options, now: () => 60_000 });
    expect(first.rows).toHaveLength(24);
    expect(first.omitted).toHaveLength(1);
    expect(first.rows.filter((row) => row.relevance !== null)).toHaveLength(6);
    expect(first.complete).toBe(false);
    const second = await assistContext(input, { ...options, now: () => 120_000 });
    expect(second.rows.filter((row) => row.relevance !== null)).toHaveLength(12);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
