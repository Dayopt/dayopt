import { describe, expect, it } from 'vitest';

import {
  candidateSetHash,
  candidateSignature,
  normalizeCandidateSet,
  reconcileVerdicts,
  sweepResultErrors,
} from './sweep-contract.mjs';

const id = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;
const candidate = (n: number, over: Record<string, unknown> = {}) => ({
  candidateId: id(n),
  title: `候補 ${n}`,
  class: 'authz',
  target: `apps/product/src/lib/auth/a.ts:${n}0`,
  scenario: '別ユーザーの行を読める',
  evidence: 'a.ts の該当箇所',
  ...over,
});

describe('candidateSignature', () => {
  it('行番号だけの違いを同じ指紋に畳む（同一欠陥の再掲を同一視するため）', () => {
    expect(candidateSignature(candidate(1))).toBe(
      candidateSignature({ ...candidate(1), target: 'apps/product/src/lib/auth/a.ts:999' }),
    );
  });

  it('class か対象ファイルが変われば別の指紋になる', () => {
    const base = candidateSignature(candidate(1));
    expect(candidateSignature({ ...candidate(1), class: 'tenant-isolation' })).not.toBe(base);
    expect(candidateSignature({ ...candidate(1), target: 'other.ts:10' })).not.toBe(base);
  });

  it('日本語だけの title でも空にならず、記号と空白の差は無視する', () => {
    const a = candidateSignature({ ...candidate(1), title: '認可の穴' });
    const b = candidateSignature({ ...candidate(1), title: '認可の穴。' });
    const c = candidateSignature({ ...candidate(1), title: '別の欠陥' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('candidateSetHash', () => {
  it('候補の並び順に依存しない（分割実行で順序が変わっても集合は同じ）', () => {
    expect(candidateSetHash([candidate(1), candidate(2)])).toBe(
      candidateSetHash([candidate(2), candidate(1)]),
    );
  });

  it('候補が 1 件でも増減すれば変わる', () => {
    expect(candidateSetHash([candidate(1), candidate(2)])).not.toBe(
      candidateSetHash([candidate(1)]),
    );
  });
});

describe('normalizeCandidateSet', () => {
  it('candidateId が UUID でなければ fail closed で落とす', () => {
    const result = normalizeCandidateSet([candidate(1, { candidateId: 'cand-1' })]);
    expect(result.errors).toEqual(['candidates[0].candidateId: UUID ではない']);
    expect(result.candidateSetHash).toBeUndefined();
  });

  it('同一 run 内の candidateId 重複を落とす（判定の取り違えを防ぐ）', () => {
    const result = normalizeCandidateSet([candidate(1), candidate(1)]);
    expect(result.errors).toEqual(['candidates[1].candidateId: 同一 run 内で重複している']);
  });

  it('signature は生成側が導出し、reviewer の申告を受け取らない', () => {
    const result = normalizeCandidateSet([
      { ...candidate(1), signature: 'deadbeefdeadbeef' } as never,
    ]);
    expect(result.candidates?.[0].signature).toBe(candidateSignature(candidate(1)));
  });
});

describe('reconcileVerdicts', () => {
  const ids = [id(1), id(2), id(3)];
  const verdict = (n: number, value: string) => ({ candidateId: id(n), verdict: value });

  it('全件そろえば未判定ゼロになる', () => {
    const result = reconcileVerdicts(
      ids,
      [verdict(1, 'confirmed'), verdict(2, 'rejected'), verdict(3, 'confirmed')],
      { key: 'verdict' },
    );
    expect(result.missing).toEqual([]);
    expect(result.decidedCount).toBe(3);
  });

  it('欠落した candidateId を名指しで残す（黙って 0 件にしない）', () => {
    const result = reconcileVerdicts(ids, [verdict(1, 'confirmed')], { key: 'verdict' });
    expect(result.missing).toEqual([id(2), id(3)]);
  });

  it('候補集合に無い id への判定を foreign として検出する（別 run の混入）', () => {
    const result = reconcileVerdicts(
      ids,
      [{ candidateId: '99999999-9999-4999-8999-999999999999', verdict: 'confirmed' }],
      { key: 'verdict' },
    );
    expect(result.foreign).toEqual(['99999999-9999-4999-8999-999999999999']);
    expect(result.missing).toHaveLength(3);
  });

  it('同一 id への食い違う判定と、同じ判定の重複を区別する', () => {
    const conflicting = reconcileVerdicts(ids, [verdict(1, 'confirmed'), verdict(1, 'rejected')], {
      key: 'verdict',
    });
    expect(conflicting.conflicting).toEqual([id(1)]);
    expect(conflicting.duplicate).toEqual([]);

    const duplicated = reconcileVerdicts(ids, [verdict(1, 'confirmed'), verdict(1, 'confirmed')], {
      key: 'verdict',
    });
    expect(duplicated.conflicting).toEqual([]);
    expect(duplicated.duplicate).toEqual([id(1)]);
  });

  it('分割実行の結果を合流させても未判定候補が消えない（中断・再開）', () => {
    const firstRound = [verdict(1, 'confirmed')];
    const partial = reconcileVerdicts(ids, firstRound, { key: 'verdict' });
    expect(partial.missing).toEqual([id(2), id(3)]);

    // 2 本目は残りだけを判定する。合流後に未判定がゼロになる。
    const merged = reconcileVerdicts(
      ids,
      [...firstRound, verdict(2, 'rejected'), verdict(3, 'needs-execution')],
      { key: 'verdict' },
    );
    expect(merged.missing).toEqual([]);
    expect(merged.decidedCount).toBe(3);
  });
});

describe('sweepResultErrors', () => {
  it('needs-execution に実行要求と期待 evidence が無ければ落とす', () => {
    const errors = sweepResultErrors('security-critic', {
      verdicts: [{ candidateId: id(1), verdict: 'needs-execution' }],
    });
    expect(errors).toEqual([
      'verdicts[0]: needs-execution には executionRequest が要る',
      'verdicts[0]: needs-execution には expectedEvidence が要る',
    ]);
  });

  it('confirmed には実行要求も counterevidence も求めない', () => {
    expect(
      sweepResultErrors('security-critic', {
        verdicts: [{ candidateId: id(1), verdict: 'confirmed' }],
      }),
    ).toEqual([]);
  });

  // pilot 実測（2026-09-10）: counterevidence を全 verdict 必須にしていたため、
  // confirmed 8 件を含む critic envelope が 12 件中 10 件 blank で invalid になった。
  // 落とす判断にだけ反証を要求する。
  it.each([['rejected'], ['undetermined']])('%s には counterevidence を要求する', (verdict) => {
    expect(
      sweepResultErrors('security-critic', { verdicts: [{ candidateId: id(1), verdict }] }),
    ).toEqual([`verdicts[0]: ${verdict} には counterevidence が要る`]);
    expect(
      sweepResultErrors('security-critic', {
        verdicts: [{ candidateId: id(1), verdict, counterevidence: 'a.ts が事前に検証する' }],
      }),
    ).toEqual([]);
  });

  it.each([['no'], ['unknown']])(
    '到達証拠 %s の失敗を failed-to-reproduce として記録させない',
    (reached) => {
      const errors = sweepResultErrors('security-reproducer', {
        attempts: [
          {
            candidateId: id(1),
            status: 'failed-to-reproduce',
            reachedTargetPath: reached,
            command: 'pnpm test:integration x',
            testPath: 'a/b.integration.test.ts',
          },
        ],
      });
      expect(errors).toEqual([
        'attempts[0]: 到達証拠のない失敗を failed-to-reproduce にしない（not-run / environment-missing へ落とす）',
      ]);
    },
  );

  it('到達を示せた失敗は、実行の出所つきなら failed-to-reproduce として通す', () => {
    expect(
      sweepResultErrors('security-reproducer', {
        attempts: [
          {
            candidateId: id(1),
            status: 'failed-to-reproduce',
            reachedTargetPath: 'yes',
            command: 'pnpm test:integration x',
            testPath: 'a/b.integration.test.ts',
          },
        ],
      }),
    ).toEqual([]);
  });

  // cross-review（risk-reviewer, GPT-5.6）の P2: reachedTargetPath は自己申告なので、
  // 実行の出所を伴わない negative を「再現せず」と記録できてしまう。
  it('reachedTargetPath だけを根拠に failed-to-reproduce を通さない', () => {
    expect(
      sweepResultErrors('security-reproducer', {
        attempts: [{ candidateId: id(1), status: 'failed-to-reproduce', reachedTargetPath: 'yes' }],
      }),
    ).toEqual([
      'attempts[0]: failed-to-reproduce には実行した command が要る',
      'attempts[0]: failed-to-reproduce には再現を書いた test の path が要る',
    ]);
  });

  it('environment-missing と not-run は到達証拠を要求しない（環境不足を再現失敗と混ぜない）', () => {
    expect(
      sweepResultErrors('security-reproducer', {
        attempts: [
          { candidateId: id(1), status: 'environment-missing', reachedTargetPath: 'unknown' },
          { candidateId: id(2), status: 'not-run', reachedTargetPath: 'no' },
          { candidateId: id(3), status: 'statically-confirmed', reachedTargetPath: 'unknown' },
        ],
      }),
    ).toEqual([]);
  });

  it('reproduced には実行した command と test の path を要求する', () => {
    expect(
      sweepResultErrors('security-reproducer', {
        attempts: [{ candidateId: id(1), status: 'reproduced', reachedTargetPath: 'yes' }],
      }),
    ).toEqual([
      'attempts[0]: reproduced には実行した command が要る',
      'attempts[0]: reproduced には再現を書いた test の path が要る',
    ]);
  });
});
