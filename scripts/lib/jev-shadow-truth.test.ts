import { describe, expect, it } from 'vitest';

import { PROTECTED_PATH_GLOBS, resolveProtectedPathGate } from '../ci/protected-path-gate.mjs';
import { JEV_MAX_INPUT_BYTES } from './jev-adapter.ts';
import {
  FREEFORM_BODY_MARKER,
  PROTECTED_GLOB_CATEGORIES,
  buildShadowRequest,
  buildShadowState,
  countCodexBadges,
  countFixRounds,
  deriveTruth,
  exceedsInputBudget,
  filterPrBodySections,
  isCodexBotLogin,
  resolveArea,
  resolveSplit,
  sanitizeLabels,
  type ShadowPrEvidence,
} from './jev-shadow-truth.ts';

const resolveGate = resolveProtectedPathGate as Parameters<typeof deriveTruth>[1]['resolveGate'];

function pr(overrides: Partial<ShadowPrEvidence> = {}): ShadowPrEvidence {
  return {
    number: 1,
    title: 'タイトル',
    body: '本文',
    labels: [],
    createdAt: '2026-09-01T00:00:00Z',
    mergedAt: '2026-09-02T00:00:00Z',
    changedFiles: 1,
    filesComplete: true,
    files: [{ filename: 'apps/product/src/features/review/Panel.tsx' }],
    reviewThreads: [],
    timeline: [],
    closingIssues: [],
    ...overrides,
  };
}

describe('保護対象 glob の写像', () => {
  it('gate の全 glob に category がある（漏れを unknown へ黙って落とさない）', () => {
    const missing = PROTECTED_PATH_GLOBS.filter((glob: string) => !PROTECTED_GLOB_CATEGORIES[glob]);
    expect(missing).toEqual([]);
  });

  it('写像側に gate が知らない glob を残さない', () => {
    const extra = Object.keys(PROTECTED_GLOB_CATEGORIES).filter(
      (glob) => !PROTECTED_PATH_GLOBS.includes(glob),
    );
    expect(extra).toEqual([]);
  });

  it('変更 file から category を集める（rename 前の path も見る）', () => {
    const truth = deriveTruth(
      pr({
        files: [
          { filename: 'supabase/migrations/20260101_x.sql' },
          { filename: 'apps/product/src/lib/billing/plan.ts' },
          { filename: 'docs/x.md', previousFilename: 'apps/product/src/features/auth/old.ts' },
        ],
      }),
      { resolveGate },
    );
    expect(truth.protectedCategories).toEqual(['auth-mcp', 'billing', 'migration']);
    expect(truth.authorizationTruth).toBe(true);
    expect(truth.publicContractTruth).toBe(true);
  });
});

describe('fix round は rebase で壊れる', () => {
  it('ready 後の force-push があれば判定不能にする', () => {
    const result = countFixRounds({
      createdAt: '2026-09-01T00:00:00Z',
      timeline: [
        { type: 'ready_for_review', at: '2026-09-01T01:00:00Z' },
        { type: 'commit', at: '2026-09-01T02:00:00Z' },
        { type: 'commit', at: '2026-09-01T03:00:00Z' },
        { type: 'force_push', at: '2026-09-01T04:00:00Z' },
      ],
    });
    expect(result).toMatchObject({ fixRounds: null, fixRoundsReason: 'force_pushed' });
  });

  it('ready 前の force-push は数えに影響しない', () => {
    const result = countFixRounds({
      createdAt: '2026-09-01T00:00:00Z',
      timeline: [
        { type: 'force_push', at: '2026-09-01T00:30:00Z' },
        { type: 'ready_for_review', at: '2026-09-01T01:00:00Z' },
        { type: 'commit', at: '2026-09-01T02:00:00Z' },
      ],
    });
    expect(result).toMatchObject({ fixRounds: 1, fixRoundsReason: 'counted' });
  });

  it('ready イベントが無ければ createdAt を起点にする（最初から ready だった PR）', () => {
    const result = countFixRounds({
      createdAt: '2026-09-01T00:00:00Z',
      timeline: [
        { type: 'commit', at: '2026-08-31T23:00:00Z' },
        { type: 'commit', at: '2026-09-01T02:00:00Z' },
      ],
    });
    expect(result).toMatchObject({ fixRounds: 1, readySource: 'createdAt' });
  });
});

describe('導出ラベル', () => {
  it('fixRounds が null の PR は narrow にしない（null <= 1 が true になる罠）', () => {
    const truth = deriveTruth(
      pr({
        timeline: [
          { type: 'ready_for_review', at: '2026-09-01T01:00:00Z' },
          { type: 'force_push', at: '2026-09-01T02:00:00Z' },
        ],
      }),
      { resolveGate },
    );
    expect(truth.fixRounds).toBeNull();
    expect(truth.narrow).toBe(false);
  });

  it('保護対象・review:full・P1 のどれかがあれば深いレビューが要ったと見る', () => {
    const byLabel = deriveTruth(pr({ labels: ['review:full'] }), { resolveGate });
    expect(byLabel.deepReviewNeeded).toBe(true);
    const byP1 = deriveTruth(
      pr({
        reviewThreads: [{ authorLogin: 'chatgpt-codex-connector', body: '![P1 Badge] まずい' }],
      }),
      { resolveGate },
    );
    expect(byP1.deepReviewNeeded).toBe(true);
  });

  it('変更 file が全件取れていなければ path 由来の label を null にする', () => {
    const truth = deriveTruth(pr({ filesComplete: false, files: [], changedFiles: 900 }), {
      resolveGate,
    });
    expect(truth.protectedCategories).toBeNull();
    expect(truth.timeInvariant).toBeNull();
    expect(truth.deepReviewNeeded).toBeNull();
    expect(truth.narrow).toBeNull();
  });

  it('時間不変条件 path を保護対象とは別に見る', () => {
    const truth = deriveTruth(
      pr({ files: [{ filename: 'apps/product/src/lib/time/day-boundary.ts' }] }),
      { resolveGate },
    );
    expect(truth.timeInvariant).toBe(true);
    expect(truth.protectedCategories).toEqual([]);
  });
});

describe('Codex の badge 集計', () => {
  it('bot 以外の本文は数えない', () => {
    const counts = countCodexBadges([
      { authorLogin: 'chatgpt-codex-connector[bot]', body: '![P1 Badge] a' },
      { authorLogin: 'chatgpt-codex-connector', body: '![P2 Badge] b' },
      { authorLogin: 't3-nico', body: '![P1 Badge] 引用しただけ' },
    ]);
    expect(counts).toEqual({ p1: 1, p2: 1 });
  });

  it('REST と GraphQL の login 表記を同じものとして扱う', () => {
    expect(isCodexBotLogin('chatgpt-codex-connector[bot]')).toBe(true);
    expect(isCodexBotLogin('chatgpt-codex-connector')).toBe(true);
    expect(isCodexBotLogin(null)).toBe(false);
  });
});

describe('state に正解を混ぜない', () => {
  const leakyPr = pr({
    labels: ['review:full', 'status:in-progress', 'area:auth'],
    body: [
      '## 関連 Issue',
      'Closes #1',
      '## Review focus',
      'auth / billing / migration に注意',
      '## 検証',
      'Codex: P1 2 件',
      '<!-- テンプレートの注記 -->',
    ].join('\n'),
    files: [{ filename: 'apps/product/src/features/auth/session.ts' }],
  });

  it('PR 本文は着手時の section だけ残す', () => {
    const { state, droppedSections } = buildShadowState(leakyPr);
    expect(state.source).toBe('pr');
    expect(state.body).toContain('関連 Issue');
    expect(state.body).not.toContain('Review focus');
    expect(state.body).not.toContain('P1 2 件');
    expect(droppedSections).toEqual(['Review focus', '検証']);
  });

  it('HTML コメントを落とす', () => {
    const { state } = buildShadowState(leakyPr);
    expect(state.body).not.toContain('テンプレートの注記');
  });

  it('review: / status: の label を送らない', () => {
    expect(sanitizeLabels(['review:full', 'status:ready', 'area:auth'])).toEqual(['area:auth']);
  });

  it('送る JSON に正解・変更 file path が現れない', () => {
    const { state } = buildShadowState(leakyPr);
    const serialized = JSON.stringify(buildShadowRequest(state));
    for (const leak of ['review:full', 'P1 Badge', 'Review focus', 'features/auth/session.ts'])
      expect(serialized).not.toContain(leak);
  });

  it('linked issue があればそちらを使う', () => {
    const { state } = buildShadowState(
      pr({
        closingIssues: [
          { number: 9, title: 'issue 題', body: 'issue 本文', labels: ['area:auth'] },
        ],
      }),
    );
    expect(state).toMatchObject({ source: 'issue', title: 'issue 題', body: 'issue 本文' });
  });

  // 実測（2026-09-18、直近 100 PR）: 見出しの無い PR 本文 11 件のうち 10 件が
  // 「指摘 3 件への修正」「pre-push 成功」「review:full 対象です」など作業後の記述を
  // 含んでいた。template を使っていない本文は後から書いた要約として扱う。
  it('見出しの無い本文は作業後の要約とみなして落とす', () => {
    const result = filterPrBodySections('独立レビューの指摘 3 件を修正。pre-push 成功。');
    expect(result).toEqual({ body: '', droppedSections: [FREEFORM_BODY_MARKER] });
  });

  it('本文が空なら落とす印も付けない', () => {
    expect(filterPrBodySections('   ')).toEqual({ body: '', droppedSections: [] });
  });

  it('題名と label は残るので case 自体は評価できる', () => {
    const { state } = buildShadowState(pr({ body: '作業後の要約', labels: ['area:auth'] }));
    expect(state).toMatchObject({
      source: 'pr',
      title: 'タイトル',
      body: '',
      labels: ['area:auth'],
    });
  });
});

describe('入力上限は実 request で測る', () => {
  it('raw では収まるが直列化で超える本文を落とす', () => {
    // 改行は JSON で 2 バイトになる。raw 長で測ると通ってしまう境界を作る。
    const lineCount = Math.floor(JEV_MAX_INPUT_BYTES / 2) + 200;
    const body = Array.from({ length: lineCount }, () => '\n').join('');
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(JEV_MAX_INPUT_BYTES);
    expect(exceedsInputBudget({ source: 'pr', title: 't', body })).toBe(true);
  });

  it('通常サイズの本文は通る', () => {
    expect(exceedsInputBudget({ source: 'pr', title: 't', body: 'x'.repeat(4000) })).toBe(false);
  });
});

describe('split と area', () => {
  it('同じ PR 番号は何度呼んでも同じ split になる', () => {
    const first = resolveSplit(2827);
    expect(resolveSplit(2827)).toBe(first);
    expect(['tune', 'holdout']).toContain(first);
  });

  it('70 / 30 におおよそ分かれる', () => {
    const numbers = Array.from({ length: 500 }, (_, index) => index + 1);
    const tune = numbers.filter((n) => resolveSplit(n) === 'tune').length;
    expect(tune / numbers.length).toBeGreaterThan(0.6);
    expect(tune / numbers.length).toBeLessThan(0.8);
  });

  it('feature 配下は feature 名、それ以外は先頭 2 segment で畳む', () => {
    expect(resolveArea('apps/product/src/features/timeblock/x/y.ts')).toBe('feature:timeblock');
    expect(resolveArea('scripts/lib/a.ts')).toBe('scripts/lib');
  });
});
