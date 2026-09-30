import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  applyMutation,
  classifyMutationRun,
  isSuccessfulMutationRun,
  selectMutationCandidates,
  summarizeMutationRun,
} from './mutation-evidence.mjs';

function outcome(status = 'passed', fullName = 'rejects a missing start') {
  return summarizeMutationRun(
    {
      numTotalTests: 1,
      numPassedTests: status === 'passed' ? 1 : 0,
      numFailedTests: status === 'failed' ? 1 : 0,
      numPendingTests: status === 'pending' ? 1 : 0,
      testResults: [
        {
          name: 'time-conflict.test.ts',
          status: status === 'failed' ? 'failed' : 'passed',
          message: '',
          assertionResults: [
            {
              fullName,
              status,
              failureMessages:
                status === 'failed' ? ['AssertionError: expected true to be false'] : [],
            },
          ],
        },
      ],
    },
    { status: status === 'failed' ? 1 : 0 },
  );
}

describe('mutation selection', () => {
  const candidates = Array.from({ length: 30 }, (_, start) => ({
    file: 'source.ts',
    start,
    end: start + 1,
  }));

  it('freezes twenty distinct sites with a reproducible seed without changing the pool', () => {
    // 守ること: 成否を見る前に重複なしの20箇所を選び、同じseedで再現できる。
    const before = JSON.stringify(candidates);
    const selected = selectMutationCandidates(candidates, 20260929);
    expect(selected).toHaveLength(20);
    expect(new Set(selected.map((site: { start: number }) => site.start)).size).toBe(20);
    expect(selected).toEqual(selectMutationCandidates(candidates, 20260929));
    expect(JSON.stringify(candidates)).toBe(before);
    expect(selected).not.toEqual(selectMutationCandidates(candidates, 20260930));
  });

  it('rejects an undersized or duplicate pool instead of claiming twenty trials', () => {
    // 守ること: 19箇所以下や同一箇所の重複を20試行の証拠にしない。
    expect(() => selectMutationCandidates(candidates.slice(0, 19), 1)).toThrow(/at least 20/);
    expect(() => selectMutationCandidates([...candidates, candidates[0]], 1)).toThrow(/Duplicate/);
  });

  it.each([Number.NaN, -1, 1.5, 2 ** 32])('rejects a seed that cannot be replayed: %s', (seed) => {
    // 守ること: seedの暗黙変換で記録と実際の乱数列を食い違わせない。
    expect(() => selectMutationCandidates(candidates, seed)).toThrow(RangeError);
  });
});

describe('mutation evidence', () => {
  it('accepts a clean baseline, detects an assertion failure, and preserves a survivor', () => {
    // 守ること: 正常完走と挙動assertionによる検出と未検出を区別する。
    const baseline = outcome();
    expect(isSuccessfulMutationRun(baseline)).toBe(true);
    expect(classifyMutationRun(outcome('failed'), baseline)).toBe('killed');
    expect(classifyMutationRun(outcome(), baseline)).toBe('survived');
  });

  it.each([
    'Error: promise resolved "data" instead of rejecting\n    at _Assertion.__VITEST_REJECTS__ (vitest)',
    'Error: promise rejected "error" instead of resolving\n    at _Assertion.__VITEST_RESOLVES__ (vitest)',
  ])('recognizes a Vitest promise assertion: %s', (message) => {
    // 守ること: 認可拒否が成功へ化けたPromise assertionの失敗も検出として数える。
    const failure = outcome('failed');
    failure.failures[0]!.messages = [message];
    expect(classifyMutationRun(failure, outcome())).toBe('killed');
  });

  it('does not trust a domain error that merely mentions a resolved promise', () => {
    // 守ること: Vitestのassertionでない業務エラー文言を検出証拠にしない。
    const failure = outcome('failed');
    failure.failures[0]!.messages = ['Error: promise resolved data instead of rejecting'];
    expect(classifyMutationRun(failure, outcome())).toBe('inconclusive');
  });

  it('rejects a replacement test even when total counts match', () => {
    // 守ること: 元のテストが消えて別テストが失敗しても検出成功にしない。
    expect(classifyMutationRun(outcome('failed', 'unrelated assertion'), outcome())).toBe(
      'inconclusive',
    );
  });

  it('does not count an import error as a behavioral detection', () => {
    // 守ること: importや型の失敗を業務挙動の回帰検出へ水増ししない。
    const failure = outcome('failed');
    failure.failures[0]!.messages = ['Error: Cannot find module missing-package'];
    expect(classifyMutationRun(failure, outcome())).toBe('inconclusive');
  });

  it.each([
    { signal: 'SIGTERM' },
    { error: 'spawn failed' },
    { reportComplete: false },
    { exitCode: null },
  ])('rejects incomplete execution: %j', (patch) => {
    // 守ること: 中断・起動失敗・不完全reportにassertionが残っていても成功にしない。
    expect(classifyMutationRun({ ...outcome('failed'), ...patch }, outcome())).toBe('inconclusive');
  });

  it('rejects skipped tests and a broken baseline or restoration', () => {
    // 守ること: skipや元から赤いsuite、復元後の欠落を正常な実験とみなさない。
    expect(isSuccessfulMutationRun(outcome('pending'))).toBe(false);
    expect(isSuccessfulMutationRun(outcome('failed'))).toBe(false);
    expect(classifyMutationRun(outcome('failed'), outcome('failed'))).toBe('inconclusive');
    expect(classifyMutationRun(outcome('pending'), outcome())).toBe('inconclusive');
  });

  it('rejects a missing JSON report even with a successful process exit', () => {
    // 守ること: 終了コード0だけでテスト実行を証明しない。
    expect(isSuccessfulMutationRun(summarizeMutationRun(null, { status: 0 }))).toBe(false);
  });
});

describe('source binding', () => {
  const source = 'return start < end;';
  const mutant = {
    file: 'time.ts',
    line: 1,
    start: 13,
    end: 14,
    before: '<',
    after: '<=',
    sha256: createHash('sha256').update(source).digest('hex'),
  };

  it('changes only the selected operator in the captured source', () => {
    // 守ること: 1試行で1箇所だけを壊し、別の変更を混ぜない。
    expect(applyMutation(source, mutant)).toBe('return start <= end;');
  });

  it('rejects stale source, stale offsets, and a no-op mutation', () => {
    // 守ること: 選択後に変わったソースや無変更を破壊試行として数えない。
    expect(() => applyMutation(`// changed\n${source}`, mutant)).toThrow(/source drift/);
    expect(() => applyMutation(source, { ...mutant, start: 12 })).toThrow(/source drift/);
    expect(() => applyMutation(source, { ...mutant, after: '<' })).toThrow(/source drift/);
  });
});
