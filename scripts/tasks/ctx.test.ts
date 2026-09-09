import { describe, expect, it, vi } from 'vitest';

import {
  bodyReferencesNumber,
  buildCommentBody,
  buildContextPack,
  buildJudgmentHint,
  buildPostArgs,
  computeCiRollup,
  countUnresolvedThreads,
  CTX_MARKER,
  detectAcceptanceCriteria,
  detectJudgmentRecords,
  extractAcceptanceCriteriaText,
  extractLinkedIssueNumbers,
  extractParentEpic,
  extractPathTokens,
  filterExistingPaths,
  findMarkerComment,
  isBotLogin,
  isPullRequest,
  mapSkills,
  nextStep,
  parseArgs,
  postContextBrief,
  renderMarkdown,
  selectComments,
  truncateBody,
  truncateCommentBody,
} from './ctx.mjs';

describe('parseArgs', () => {
  it('番号のみ指定した既定値', () => {
    expect(parseArgs(['2550'])).toEqual({
      number: 2550,
      json: false,
      comments: 5,
      bodyLines: 60,
      allComments: false,
      post: false,
    });
  });

  it('--json / --comments / --body-lines / --all-comments を解釈する', () => {
    expect(
      parseArgs(['2550', '--json', '--comments', '3', '--body-lines', '10', '--all-comments']),
    ).toEqual({
      number: 2550,
      json: true,
      comments: 3,
      bodyLines: 10,
      allComments: true,
      post: false,
    });
  });

  it('--post を解釈する', () => {
    expect(parseArgs(['2550', '--post'])).toMatchObject({ number: 2550, post: true });
  });

  it('番号が無い・不正・複数は例外', () => {
    expect(() => parseArgs([])).toThrow(/番号を 1 つ/);
    expect(() => parseArgs(['abc'])).toThrow(/不正な番号/);
    expect(() => parseArgs(['1', '2'])).toThrow(/番号を 1 つ/);
  });

  it('未知の引数は例外', () => {
    expect(() => parseArgs(['1', '--foo'])).toThrow(/未知の引数/);
  });
});

describe('isPullRequest', () => {
  it('pull_request キーの有無で判定する', () => {
    expect(isPullRequest({ pull_request: { url: 'x' } })).toBe(true);
    expect(isPullRequest({ title: 'issue' })).toBe(false);
    expect(isPullRequest(null)).toBe(false);
  });
});

describe('truncateBody', () => {
  it('maxLines 以下ならそのまま', () => {
    expect(truncateBody('a\nb', 60)).toEqual({ text: 'a\nb', truncated: false, remaining: 0 });
  });

  it('超過分は切り詰めて残り行数を返す', () => {
    const body = Array.from({ length: 65 }, (_, i) => `line${i}`).join('\n');
    const result = truncateBody(body, 60);
    expect(result.truncated).toBe(true);
    expect(result.remaining).toBe(5);
    expect(result.text.split('\n')).toHaveLength(60);
  });

  it('bodyLines=0 は切り詰めない', () => {
    const body = 'a\nb\nc';
    expect(truncateBody(body, 0)).toEqual({ text: body, truncated: false, remaining: 0 });
  });
});

describe('truncateCommentBody', () => {
  it('先頭 8 行だけ残す', () => {
    const body = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    expect(truncateCommentBody(body).split('\n')).toHaveLength(8);
  });
});

describe('isBotLogin / selectComments', () => {
  it('[bot] で終わる login を bot 判定する', () => {
    expect(isBotLogin('github-actions[bot]')).toBe(true);
    expect(isBotLogin('tomoya')).toBe(false);
  });

  const comments = [
    { user: { login: 'a' }, created_at: '2026-08-01T00:00:00Z', body: '1' },
    { user: { login: 'github-actions[bot]' }, created_at: '2026-08-02T00:00:00Z', body: '2' },
    { user: { login: 'b' }, created_at: '2026-08-03T00:00:00Z', body: '3' },
    { user: { login: 'c' }, created_at: '2026-08-04T00:00:00Z', body: '4' },
  ];

  it('既定は bot を除外して最新 K 件', () => {
    const selected = selectComments(comments, 2, false);
    expect(selected.map((c) => c.body)).toEqual(['3', '4']);
  });

  it('--all-comments 相当（allComments=true）なら bot も含める', () => {
    const selected = selectComments(comments, 2, true);
    expect(selected.map((c) => c.body)).toEqual(['3', '4']);
    const selectedAll = selectComments(comments, 4, true);
    expect(selectedAll.map((c) => c.body)).toEqual(['1', '2', '3', '4']);
  });

  it('k=0 は空配列', () => {
    expect(selectComments(comments, 0, false)).toEqual([]);
  });

  it('F2: Main 自身の marker / brief コメントは allComments 指定に関わらず常に除外する', () => {
    const withMarkers = [
      { user: { login: 'a' }, created_at: '2026-08-01T00:00:00Z', body: '1' },
      {
        user: { login: 'claude' },
        created_at: '2026-08-02T00:00:00Z',
        body: `${CTX_MARKER}\n**brief（...）**`,
      },
      {
        user: { login: 'claude' },
        created_at: '2026-08-03T00:00:00Z',
        body: '[internal-review]\nfindings...',
      },
      {
        user: { login: 'codex' },
        created_at: '2026-08-04T00:00:00Z',
        body: '[codex-issue-review]\nfindings...',
      },
      { user: { login: 'b' }, created_at: '2026-08-05T00:00:00Z', body: '5' },
    ];
    expect(selectComments(withMarkers, 10, false).map((c) => c.body)).toEqual(['1', '5']);
    expect(selectComments(withMarkers, 10, true).map((c) => c.body)).toEqual(['1', '5']);
  });

  it('Codex（chatgpt-codex-connector[bot]）は bot 除外の対象外にする（実装前レビューを見落とさない）', () => {
    const withCodex = [
      { user: { login: 'a' }, created_at: '2026-08-01T00:00:00Z', body: '1' },
      {
        user: { login: 'chatgpt-codex-connector[bot]' },
        created_at: '2026-08-02T00:00:00Z',
        body: 'Codex のレビューコメント: P1 の指摘あり',
      },
      // 他の bot（dependabot 等）は引き続き除外する。
      {
        user: { login: 'dependabot[bot]' },
        created_at: '2026-08-03T00:00:00Z',
        body: 'dependency bump',
      },
    ];
    expect(selectComments(withCodex, 10, false).map((c) => c.body)).toEqual([
      '1',
      'Codex のレビューコメント: P1 の指摘あり',
    ]);
  });
});

describe('extractLinkedIssueNumbers', () => {
  it('単一の Closes/Refs/Fixes を拾う', () => {
    expect(extractLinkedIssueNumbers('Closes #123')).toEqual([123]);
    expect(extractLinkedIssueNumbers('Refs #45 の続き')).toEqual([45]);
    expect(extractLinkedIssueNumbers('Fixes #7')).toEqual([7]);
  });

  it('`Closes #1, #2` は両方を拾う（実際に close するのは先頭のみだが列挙対象にする）', () => {
    expect(extractLinkedIssueNumbers('Closes #1, #2')).toEqual([1, 2]);
  });

  it('複数キーワードの重複は 1 回にまとめる', () => {
    expect(extractLinkedIssueNumbers('Closes #1\n\nRefs #1, #2')).toEqual([1, 2]);
  });

  it('該当なしは空配列', () => {
    expect(extractLinkedIssueNumbers('ただの本文 #1')).toEqual([]);
    expect(extractLinkedIssueNumbers(null)).toEqual([]);
  });
});

describe('extractParentEpic', () => {
  it('sub-issue of #M を優先する', () => {
    expect(extractParentEpic('sub-issue of #10\nRefs #20')).toBe(10);
  });

  it('無ければ Refs #M の初出', () => {
    expect(extractParentEpic('本文\nRefs #20\nRefs #30')).toBe(20);
  });

  it('どちらも無ければ null', () => {
    expect(extractParentEpic('ただの本文')).toBeNull();
    expect(extractParentEpic(null)).toBeNull();
  });
});

describe('bodyReferencesNumber', () => {
  it('Closes #12 が #12 に一致し #120 には一致しない', () => {
    expect(bodyReferencesNumber('Closes #12', 12)).toBe(true);
    expect(bodyReferencesNumber('Closes #120', 12)).toBe(false);
  });

  it('カンマ区切りの 2 番目も一致する', () => {
    expect(bodyReferencesNumber('Closes #1, #2', 2)).toBe(true);
  });
});

describe('extractPathTokens / filterExistingPaths', () => {
  it('拡張子付き path らしき token を抽出する', () => {
    expect(extractPathTokens('see apps/product/src/foo.ts and docs/bar.md, done')).toEqual([
      'apps/product/src/foo.ts',
      'docs/bar.md',
    ]);
  });

  it('existsFn で実在するものだけ残す', () => {
    const existsFn = (p: string) => p.endsWith('real.ts');
    const result = filterExistingPaths(['a/real.ts', 'b/fake.ts'], existsFn, '/repo');
    expect(result).toEqual(['a/real.ts']);
  });
});

describe('computeCiRollup', () => {
  it('CheckRun の conclusion / StatusContext の state を分類する', () => {
    const rollup = [
      { conclusion: 'SUCCESS' },
      { conclusion: 'FAILURE' },
      { status: 'IN_PROGRESS' },
      { state: 'PENDING' },
      { state: 'ERROR' },
    ];
    expect(computeCiRollup(rollup)).toEqual({ success: 1, failure: 2, pending: 2 });
  });

  it('空配列は全 0', () => {
    expect(computeCiRollup([])).toEqual({ success: 0, failure: 0, pending: 0 });
    expect(computeCiRollup(undefined)).toEqual({ success: 0, failure: 0, pending: 0 });
  });
});

describe('countUnresolvedThreads', () => {
  it('isResolved=false の件数を数える', () => {
    expect(
      countUnresolvedThreads([{ isResolved: true }, { isResolved: false }, { isResolved: false }]),
    ).toBe(2);
  });

  it('空・未取得は 0', () => {
    expect(countUnresolvedThreads([])).toBe(0);
    expect(countUnresolvedThreads(undefined)).toBe(0);
  });
});

describe('mapSkills', () => {
  it('ファイル種別ごとに正しい skill を対応付ける', () => {
    expect(mapSkills(['supabase/migrations/0001_x.sql'], false)).toEqual(['supabase']);
    expect(mapSkills(['apps/product/src/features/foo/server/router.ts'], false)).toEqual([
      'trpc-router-creating',
      'security',
    ]);
    expect(mapSkills(['packages/components/Button.stories.tsx'], false)).toEqual(['storybook']);
    expect(mapSkills(['apps/product/messages/ja/common.json'], false)).toEqual(['i18n']);
    expect(mapSkills(['docs/foo.md'], false)).toEqual(['docs-writing']);
    expect(mapSkills(['scripts/ci/check.mjs'], false)).toEqual(['pr-cross-review']);
    expect(mapSkills(['foo.test.ts'], false)).toEqual(['test']);
  });

  it('protectedRequired なら pr-cross-review を必ず含める', () => {
    expect(mapSkills(['README.md'], true)).toEqual(['pr-cross-review']);
  });

  it('重複は 1 回にまとめる', () => {
    const skills = mapSkills(
      ['apps/product/src/features/foo/server/router.ts', 'foo.test.ts'],
      false,
    );
    expect(new Set(skills).size).toBe(skills.length);
  });
});

describe('detectJudgmentRecords', () => {
  it('DoD は bot 以外のコメントまたは body の言及で あり', () => {
    expect(detectJudgmentRecords([], 'ここに DoD を書く')).toMatchObject({ dod: true });
    expect(
      detectJudgmentRecords([{ user: { login: 'tomoya' }, body: '完了の定義: XXX' }], ''),
    ).toMatchObject({ dod: true });
    expect(
      detectJudgmentRecords([{ user: { login: 'github-actions[bot]' }, body: 'DoD: XXX' }], ''),
    ).toMatchObject({ dod: false });
  });

  it('ctx brief 自身（CTX_MARKER コメント）の「DoD: なし | 分解表: なし」で dod/breakdown が誤って true にならない（自己言及の除外）', () => {
    const briefComment = {
      user: { login: 'tomoya' },
      author_association: 'OWNER',
      body: `${CTX_MARKER}\n**brief（\`pnpm ctx 1\`、2026-09-01）**\n\n#### 判断の記録\n\nDoD: なし | 分解表: なし | brief: あり`,
    };
    expect(detectJudgmentRecords([briefComment], '')).toMatchObject({
      dod: false,
      breakdown: false,
      brief: true,
    });
  });

  it('分解表は subtask/tier 列の表、または「分解表」の語で あり', () => {
    expect(detectJudgmentRecords([], '## 分解表\n本文')).toMatchObject({ breakdown: true });
    expect(
      detectJudgmentRecords(
        [{ user: { login: 'tomoya' }, body: '| # | subtask | tier | 入力 |\n| - | - | - | - |' }],
        '',
      ),
    ).toMatchObject({ breakdown: true });
    expect(detectJudgmentRecords([], '本文だけ')).toMatchObject({ breakdown: false });
  });

  it('brief は CTX_MARKER で始まる、かつ author_association が信頼できるコメントの有無', () => {
    expect(
      detectJudgmentRecords(
        [{ user: { login: 'tomoya' }, author_association: 'OWNER', body: `${CTX_MARKER}\n本文` }],
        '',
      ),
    ).toMatchObject({ brief: true });
    expect(detectJudgmentRecords([{ user: { login: 'tomoya' }, body: '普通' }], '')).toMatchObject({
      brief: false,
    });
  });

  it('F2: brief は author_association が NONE/CONTRIBUTOR 等（信頼できない）だと あり にならない', () => {
    expect(
      detectJudgmentRecords(
        [
          {
            user: { login: 'randomuser' },
            author_association: 'NONE',
            body: `${CTX_MARKER}\n偽の brief`,
          },
        ],
        '',
      ),
    ).toMatchObject({ brief: false });
  });

  it('#2560 項目 6: 信頼できない author の marker 風コメントは判定から除外されない（DoD を隠せない）', () => {
    // 以前は prefix 一致だけで除外していたため、第三者が CTX_MARKER で始まる
    // コメントを投稿するだけで、そのコメントを DoD/分解表 の走査対象から外せた。
    const spoofed = {
      user: { login: 'randomuser' },
      author_association: 'NONE',
      body: `${CTX_MARKER}\n完了の定義: 本物の DoD がここにある`,
    };

    expect(detectJudgmentRecords([spoofed], '')).toMatchObject({
      dod: true,
      // 偽 marker なので brief 自体は あり にならない（F2 の既存挙動）。
      brief: false,
    });
  });

  it('#2560 項目 6: 信頼できない author の marker 風コメントは分解表の走査からも外れない', () => {
    const spoofed = {
      user: { login: 'randomuser' },
      author_association: 'NONE',
      body: `${CTX_MARKER}\n## 分解表\n本文`,
    };

    expect(detectJudgmentRecords([spoofed], '')).toMatchObject({ breakdown: true });
  });

  it('全て なし の場合', () => {
    expect(detectJudgmentRecords([], '')).toEqual({ dod: false, breakdown: false, brief: false });
  });
});

describe('detectAcceptanceCriteria', () => {
  it('受け入れ条件は語句、または「## やること」の箇条書きで あり', () => {
    expect(detectAcceptanceCriteria('## 受け入れ条件\n- できる')).toMatchObject({
      acceptance: true,
    });
    expect(detectAcceptanceCriteria('完了条件: XXX')).toMatchObject({ acceptance: true });
    expect(detectAcceptanceCriteria('## やること\n- [ ] 実装する\n- [ ] test\n')).toMatchObject({
      acceptance: true,
    });
    expect(detectAcceptanceCriteria('## やること\n\n## 別セクション\n- 無関係')).toMatchObject({
      acceptance: false,
    });
    expect(detectAcceptanceCriteria('本文だけ')).toMatchObject({ acceptance: false });
    expect(detectAcceptanceCriteria(undefined)).toMatchObject({ acceptance: false });
  });

  it('検証コマンドは fenced code block、pnpm/gh/node/git/rg/npx のインラインコード、または expect( で あり', () => {
    expect(detectAcceptanceCriteria('## 検証\n```\npnpm test\n```')).toMatchObject({
      verification: true,
    });
    expect(detectAcceptanceCriteria('## 検証\n`pnpm typecheck` を通す')).toMatchObject({
      verification: true,
    });
    expect(detectAcceptanceCriteria('## 検証\n`gh pr view 1` で確認')).toMatchObject({
      verification: true,
    });
    expect(detectAcceptanceCriteria('## 検証\nexpect(result).toBe(true) を足す')).toMatchObject({
      verification: true,
    });
    expect(detectAcceptanceCriteria('## 検証\n`ls -la` を実行')).toMatchObject({
      verification: false,
    });
    expect(detectAcceptanceCriteria('本文だけ')).toMatchObject({ verification: false });
  });

  it('`## 検証` セクションの外にある fenced block / インラインコードは検証コマンドとして数えない', () => {
    // §検証 セクションが無い（見出し自体が無い）本文中の言及は無視する。
    expect(detectAcceptanceCriteria('`pnpm typecheck` を通す')).toMatchObject({
      verification: false,
    });
    expect(detectAcceptanceCriteria('```\npnpm test\n```')).toMatchObject({ verification: false });
    // §検証 セクションの手前・別セクションの言及も無視する。
    expect(
      detectAcceptanceCriteria(
        ['`pnpm test` は雑談で出ただけ', '## 検証', '特に無し', '## 別セクション', '```'].join(
          '\n',
        ),
      ),
    ).toMatchObject({ verification: false });
  });
});

describe('extractAcceptanceCriteriaText', () => {
  it('## やること と ## 検証 セクションがあれば両方連結して返す', () => {
    const body = [
      '## やること',
      '- [ ] API を実装する',
      '- [ ] test を足す',
      '## 検証',
      '`pnpm test` が通る',
      '## 別セクション（無関係）',
      '無視される',
    ].join('\n');
    const text = extractAcceptanceCriteriaText(body);
    expect(text).toContain('## やること');
    expect(text).toContain('API を実装する');
    expect(text).toContain('## 検証');
    expect(text).toContain('`pnpm test` が通る');
    expect(text).not.toContain('無視される');
  });

  it('セクション見出しが無ければ「受け入れ条件」「完了条件」を含む行だけを返す', () => {
    const body = ['雑談', '受け入れ条件: ログインできる', '完了条件: エラーが出ない', '雑談2'].join(
      '\n',
    );
    const text = extractAcceptanceCriteriaText(body);
    expect(text).toBe('受け入れ条件: ログインできる\n完了条件: エラーが出ない');
  });

  it('何も見つからなければ空文字', () => {
    expect(extractAcceptanceCriteriaText('本文だけ')).toBe('');
    expect(extractAcceptanceCriteriaText(undefined)).toBe('');
  });
});

describe('buildJudgmentHint', () => {
  it('欠けているものだけ列挙する', () => {
    expect(buildJudgmentHint({ dod: false, breakdown: true, brief: true })).toBe(
      '判断の記録が欠けている: DoD（routing skill 手順 1 / dispatch 手順 7）',
    );
    expect(buildJudgmentHint({ dod: false, breakdown: false, brief: false })).toBe(
      '判断の記録が欠けている: DoD・分解表・brief（routing skill 手順 1 / dispatch 手順 7）',
    );
  });

  it('全て あり、または records が無ければ null', () => {
    expect(buildJudgmentHint({ dod: true, breakdown: true, brief: true })).toBeNull();
    expect(buildJudgmentHint(null)).toBeNull();
  });

  it('受け入れ条件・検証コマンドも欠けていれば列挙する（フィールドが無ければ判定しない）', () => {
    expect(
      buildJudgmentHint({
        dod: true,
        breakdown: true,
        brief: true,
        acceptance: false,
        verification: false,
      }),
    ).toBe(
      '判断の記録が欠けている: 受け入れ条件・検証コマンド（dispatch §status:ready の機械判定）（routing skill 手順 1 / dispatch 手順 7）',
    );
    expect(
      buildJudgmentHint({
        dod: true,
        breakdown: true,
        brief: true,
        acceptance: true,
        verification: true,
      }),
    ).toBeNull();
  });
});

describe('nextStep', () => {
  it('issue で紐付く PR が無い', () => {
    expect(nextStep({ kind: 'issue', number: 1, hasLinkedPr: false })).toBe(
      '分解表を issue コメントに書く（routing skill）',
    );
  });

  it('PR draft かつ CI 失敗', () => {
    expect(
      nextStep({
        kind: 'pr',
        number: 1,
        isDraft: true,
        ciRollup: { success: 0, failure: 1, pending: 0 },
        unresolvedThreads: 0,
      }),
    ).toBe('失敗 check を直す');
  });

  it('PR ready かつ未解決 thread あり', () => {
    expect(
      nextStep({
        kind: 'pr',
        number: 1,
        isDraft: false,
        ciRollup: { success: 3, failure: 0, pending: 0 },
        unresolvedThreads: 2,
      }),
    ).toBe('thread を resolve');
  });

  it('PR green + resolved なら branch:finish', () => {
    expect(
      nextStep({
        kind: 'pr',
        number: 42,
        isDraft: false,
        ciRollup: { success: 3, failure: 0, pending: 0 },
        unresolvedThreads: 0,
      }),
    ).toBe('pnpm branch:finish 42');
  });

  it('CI が pending 中なら branch:finish ではなく完走待ちを促す', () => {
    expect(
      nextStep({
        kind: 'pr',
        number: 42,
        isDraft: false,
        ciRollup: { success: 2, failure: 0, pending: 1 },
        unresolvedThreads: 0,
      }),
    ).toBe('CI の完走を待つ（pending 1）');
  });

  it('#2560 項目 3: draft かつ未解決 thread あり は「未取得」と騙らず状態を名指しする', () => {
    const result = nextStep({
      kind: 'pr',
      number: 42,
      isDraft: true,
      ciRollup: { success: 3, failure: 0, pending: 0 },
      unresolvedThreads: 2,
    });

    // 3 つとも取得できているので「未取得」とは言わない。
    expect(result).not.toContain('未取得');
    expect(result).toBe('thread を resolve してから ready 化する（未解決 2、gh pr ready 42）');
  });

  it('#2560 項目 3: 3 つとも取得できていれば、どの組み合わせでも「未取得」と言わない', () => {
    // 「未取得」を名乗ってよいのは実際に取得できていない時だけ、という不変条件を
    // 組み合わせ網羅で固定する。項目 3 の実バグ（draft かつ未解決 thread あり）は
    // この網羅の 1 ケースで、同じ穴が別の組み合わせで再発しても落ちる。
    const drafts = [true, false];
    const threadCounts = [0, 2];
    const rollups = [
      { success: 3, failure: 0, pending: 0 },
      { success: 0, failure: 1, pending: 0 },
      { success: 1, failure: 0, pending: 2 },
      { success: 0, failure: 0, pending: 0 },
    ];
    const mergeStates = ['', 'CLEAN', 'BLOCKED'];

    for (const isDraft of drafts) {
      for (const unresolvedThreads of threadCounts) {
        for (const ciRollup of rollups) {
          for (const mergeStateStatus of mergeStates) {
            const result = nextStep({
              kind: 'pr',
              number: 42,
              isDraft,
              ciRollup,
              unresolvedThreads,
              mergeStateStatus,
            });

            expect(
              result,
              `isDraft=${isDraft} threads=${unresolvedThreads} ci=${JSON.stringify(ciRollup)} merge=${mergeStateStatus}`,
            ).not.toContain('未取得');
            expect(result).not.toBe('');
          }
        }
      }
    }
  });

  it('CI rollup・未解決 thread・isDraft のいずれかが未取得（null）なら判断保留にする（branch:finish の fail-open 防止）', () => {
    expect(
      nextStep({
        kind: 'pr',
        number: 42,
        isDraft: false,
        ciRollup: null,
        unresolvedThreads: 0,
      }),
    ).toBe('状態が未取得のため判断保留（gh の再実行）');
    expect(
      nextStep({
        kind: 'pr',
        number: 42,
        isDraft: false,
        ciRollup: { success: 3, failure: 0, pending: 0 },
        unresolvedThreads: null,
      }),
    ).toBe('状態が未取得のため判断保留（gh の再実行）');
    expect(
      nextStep({
        kind: 'pr',
        number: 42,
        isDraft: null,
        ciRollup: { success: 3, failure: 0, pending: 0 },
        unresolvedThreads: 0,
      }),
    ).toBe('状態が未取得のため判断保留（gh の再実行）');
  });

  it('issue で PR 紐付き済みは空文字', () => {
    expect(nextStep({ kind: 'issue', number: 1, hasLinkedPr: true, linkedPrNumber: 5 })).toBe(
      'linked PR #5 を進める（pnpm ctx 5）',
    );
  });

  it('PR が main から乖離（DIRTY / BEHIND）していれば追従を最優先で促す', () => {
    expect(
      nextStep({
        kind: 'pr',
        number: 7,
        isDraft: false,
        ciRollup: { success: 0, failure: 1, pending: 0 },
        mergeStateStatus: 'DIRTY',
      }),
    ).toBe('origin/main を merge して追従する（mergeStateStatus: DIRTY）');
    expect(
      nextStep({ kind: 'pr', number: 7, isDraft: true, mergeStateStatus: 'BEHIND' }),
    ).toContain('BEHIND');
  });

  it('draft で CI green・thread ゼロなら ready 化を促す', () => {
    expect(
      nextStep({
        kind: 'pr',
        number: 9,
        isDraft: true,
        ciRollup: { success: 3, failure: 0, pending: 0 },
        unresolvedThreads: 0,
      }),
    ).toBe('pnpm check を通して ready 化する（gh pr ready 9）');
  });
});

describe('buildContextPack (execFileImpl 経由の gh 呼び出し形)', () => {
  it('表示から省略された本文でも振り分けと資料の鮮度に反映する', () => {
    const make = (suffix: string) =>
      buildContextPack(
        { number: 123, comments: 5, bodyLines: 5, allComments: false },
        {
          existsFn: () => true,
          readFileImpl: () => '',
          execFileImpl: (_cmd: string, args: string[]) => {
            if (args[1] === 'repos/Dayopt/dayopt/issues/123')
              return JSON.stringify({
                title: '資料の更新',
                state: 'open',
                labels: [],
                html_url: 'https://github.com/Dayopt/dayopt/issues/123',
                body: `## やること\n受け入れ条件: scripts/tasks/ctx.mjs の結果を確認\n## 検証\n\`pnpm test:scripts\`\n${'説明\n'.repeat(70)}${suffix}`,
              });
            return '[]';
          },
        },
      );
    const first = make('OAuth の判断を含む');
    const next = make('OAuth の判断を変更する');
    expect(first.body.text).not.toContain('OAuth');
    expect(first.routing).toMatchObject({ level: 'L3', ready: true, preparation: 'L1' });
    expect(first.body.text).toBe(next.body.text);
    expect(first.bodySha256).not.toBe(next.bodySha256);
    expect(renderMarkdown(first)).toContain('実装・判断: L3');
  });
  it('issue: issues API → comments → search prs → pr view(headRefName,files) の順で argv を渡す', () => {
    const calls: string[][] = [];
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === `repos/Dayopt/dayopt/issues/2550`) {
        return JSON.stringify({
          title: 'issue タイトル',
          state: 'open',
          labels: [{ name: 'bug' }],
          milestone: null,
          assignees: [],
          html_url: 'https://github.com/Dayopt/dayopt/issues/2550',
          body: 'Refs #1\n触るファイル: apps/product/src/foo.ts',
        });
      }
      if (
        args[0] === 'api' &&
        args[1] === 'repos/Dayopt/dayopt/issues/2550/comments?per_page=100'
      ) {
        return JSON.stringify([
          { user: { login: 'tomoya' }, created_at: '2026-08-01T00:00:00Z', body: 'コメント' },
        ]);
      }
      if (args[0] === 'api' && args[1] === 'repos/Dayopt/dayopt/issues/1') {
        return JSON.stringify({ state: 'open', title: '親 issue', labels: [] });
      }
      if (args[0] === 'search') {
        return JSON.stringify([{ number: 99, title: 'PR', state: 'OPEN', body: 'Closes #2550' }]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          headRefName: 'sonnet/foo-2550',
          files: [{ path: 'apps/product/src/foo.ts' }],
        });
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const pack = buildContextPack(
      { number: 2550, comments: 5, bodyLines: 60, allComments: false },
      { execFileImpl, existsFn: (p: string) => p.endsWith('foo.ts'), readFileImpl: () => '' },
    );

    expect(pack.kind).toBe('issue');
    expect(pack.header.title).toBe('issue タイトル');
    expect(pack.related.parentEpic).toEqual({ number: 1, state: 'open', title: '親 issue' });
    expect(pack.related.prs).toEqual([
      { number: 99, state: 'OPEN', title: 'PR', headRefName: 'sonnet/foo-2550' },
    ]);
    expect(pack.files).toContain('apps/product/src/foo.ts');
    expect(pack.routing).toMatchObject({ level: 'unclassified', preparation: 'L1', ready: false });
    expect(calls[0]).toEqual(['api', 'repos/Dayopt/dayopt/issues/2550']);
    expect(pack.judgmentRecords).toEqual({
      dod: false,
      breakdown: false,
      brief: false,
      acceptance: false,
      verification: false,
    });
    expect(pack.nextStepSecondary).toBe(
      '判断の記録が欠けている: DoD・分解表・brief・受け入れ条件・検証コマンド（dispatch §status:ready の機械判定）（routing skill 手順 1 / dispatch 手順 7）',
    );
  });

  it('issue: linked PR が CLOSED/MERGED だけなら次の一手を駆動しない（分解表を促す）', () => {
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'api' && args[1] === `repos/Dayopt/dayopt/issues/2550`) {
        return JSON.stringify({
          title: 'issue タイトル',
          state: 'open',
          labels: [],
          milestone: null,
          assignees: [],
          html_url: 'x',
          body: '',
        });
      }
      if (
        args[0] === 'api' &&
        args[1] === 'repos/Dayopt/dayopt/issues/2550/comments?per_page=100'
      ) {
        return JSON.stringify([]);
      }
      if (args[0] === 'search') {
        return JSON.stringify([
          { number: 90, title: 'PR (closed)', state: 'CLOSED', body: 'Closes #2550' },
          { number: 91, title: 'PR (merged)', state: 'MERGED', body: 'Closes #2550' },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ headRefName: 'sonnet/foo-2550', files: [] });
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const pack = buildContextPack(
      { number: 2550, comments: 5, bodyLines: 60, allComments: false },
      { execFileImpl, existsFn: () => false, readFileImpl: () => '' },
    );

    // 関連セクションには closed/merged PR も引き続き載る。
    expect(pack.related.prs).toEqual([
      { number: 90, state: 'CLOSED', title: 'PR (closed)', headRefName: 'sonnet/foo-2550' },
      { number: 91, state: 'MERGED', title: 'PR (merged)', headRefName: 'sonnet/foo-2550' },
    ]);
    // だが次の一手は「紐付き済み」扱いにしない（linked PR #90/#91 を進める、には
    // ならない）。judgmentHint が上書きするため実際の文言は「分解表」を含む
    // 判断の記録の欠落ヒントになる。
    expect(pack.nextStep).not.toContain('linked PR');
    expect(pack.nextStep).toContain('分解表');
  });

  it('PR: pull_request キー検出後 pr view + graphql(reviewThreads) を呼ぶ', () => {
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'api' && args[1] === `repos/Dayopt/dayopt/issues/2549`) {
        return JSON.stringify({ pull_request: { url: 'x' } });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 2549,
          title: 'PR タイトル',
          state: 'OPEN',
          url: 'https://github.com/Dayopt/dayopt/pull/2549',
          labels: [],
          milestone: null,
          assignees: [],
          headRefName: 'sonnet/foo',
          baseRefName: 'main',
          isDraft: false,
          mergeStateStatus: 'CLEAN',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          body: 'Closes #2550',
          files: [{ path: 'apps/product/src/foo.ts' }],
        });
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        expect(args.some((a) => a.includes('reviewThreads'))).toBe(true);
        return JSON.stringify({
          data: {
            repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }] } } },
          },
        });
      }
      if (
        args[0] === 'api' &&
        args[1] === 'repos/Dayopt/dayopt/issues/2549/comments?per_page=100'
      ) {
        return JSON.stringify([]);
      }
      if (args[0] === 'api' && args[1] === 'repos/Dayopt/dayopt/issues/2550') {
        return JSON.stringify({ state: 'closed', title: '紐付け issue', labels: [] });
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const pack = buildContextPack(
      { number: 2549, comments: 5, bodyLines: 60, allComments: false },
      { execFileImpl, existsFn: () => false, readFileImpl: () => '' },
    );

    expect(pack.kind).toBe('pr');
    expect(pack.header.headRefName).toBe('sonnet/foo');
    expect(pack.header.unresolvedThreads).toBe(0);
    expect(pack.related.linkedIssues).toEqual([
      { number: 2550, state: 'closed', title: '紐付け issue', labels: [], acceptanceText: '' },
    ]);
    expect(pack.nextStep).toBe('pnpm branch:finish 2549');
    expect(pack.judgmentRecords).toBeNull();
  });

  it('PR: reviewThreads が 100 件を超えたら pageInfo.hasNextPage で追加ページを取得し全件数える', () => {
    let graphqlCallCount = 0;
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'api' && args[1] === `repos/Dayopt/dayopt/issues/2549`) {
        return JSON.stringify({ pull_request: { url: 'x' } });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 2549,
          title: 'PR タイトル',
          state: 'OPEN',
          url: 'x',
          labels: [],
          milestone: null,
          assignees: [],
          headRefName: 'sonnet/foo',
          baseRefName: 'main',
          isDraft: false,
          mergeStateStatus: 'CLEAN',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          body: '',
          files: [],
        });
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        graphqlCallCount += 1;
        if (graphqlCallCount === 1) {
          expect(args.some((a) => a.startsWith('after='))).toBe(false);
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [{ isResolved: false }],
                    pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' },
                  },
                },
              },
            },
          });
        }
        expect(args.some((a) => a === 'after=CURSOR1')).toBe(true);
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ isResolved: false }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      if (
        args[0] === 'api' &&
        args[1] === 'repos/Dayopt/dayopt/issues/2549/comments?per_page=100'
      ) {
        return JSON.stringify([]);
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const pack = buildContextPack(
      { number: 2549, comments: 5, bodyLines: 60, allComments: false },
      { execFileImpl, existsFn: () => false, readFileImpl: () => '' },
    );

    expect(graphqlCallCount).toBe(2);
    expect(pack.header.unresolvedThreads).toBe(2);
  });

  it('gh 呼び出し全滅でも例外にせず未取得の pack を返す', () => {
    const execFileImpl = vi.fn(() => {
      throw new Error('gh not found');
    });
    const pack = buildContextPack(
      { number: 1, comments: 5, bodyLines: 60, allComments: false },
      {
        execFileImpl,
        existsFn: () => false,
        readFileImpl: () => {
          throw new Error('no file');
        },
      },
    );
    expect(pack.kind).toBe('issue');
    expect(pack.header.title).toBeNull();
    expect(pack.comments).toBeNull();
    expect(pack.protectedRequired).toBe(false);
  });
});

describe('renderMarkdown', () => {
  it('固定 fixture で全セクションを描画し150行以内に収める', () => {
    const pack = {
      number: 2549,
      kind: 'pr' as const,
      header: {
        title: 'PR タイトル',
        state: 'OPEN',
        labels: ['area:ctx'],
        milestone: null,
        assignee: 'tomoya',
        url: 'https://github.com/Dayopt/dayopt/pull/2549',
        headRefName: 'sonnet/foo',
        baseRefName: 'main',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        ciRollup: { success: 3, failure: 0, pending: 0 },
        unresolvedThreads: 0,
      },
      body: { text: '本文の抜粋', truncated: true, remaining: 10 },
      comments: [{ author: 'tomoya', date: '2026-08-01', body: 'レビューコメント' }],
      related: {
        parentEpic: null,
        prs: null,
        linkedIssues: [{ number: 2550, state: 'closed', title: '紐付け issue', labels: ['bug'] }],
      },
      files: ['apps/product/src/foo.ts', 'scripts/ci/check.mjs'],
      protectedRequired: true,
      decisionLines: ['2026-08-01 #2549 の決定ログ行'],
      skills: ['pr-cross-review', 'test'],
      judgmentRecords: { dod: true, breakdown: false, brief: true },
      nextStep: 'pnpm branch:finish 2549',
      nextStepSecondary: '判断の記録が欠けている: 分解表（routing skill 手順 1 / dispatch 手順 7）',
    };

    const markdown = renderMarkdown(pack);
    expect(markdown).toContain('### #2549 PR タイトル');
    expect(markdown).toContain('種別: PR');
    expect(markdown).toContain('sonnet/foo → main');
    expect(markdown).toContain('CI: SUCCESS 3 / FAILURE 0 / PENDING 0');
    expect(markdown).toContain('未解決 thread: 0');
    expect(markdown).toContain('#### 本文');
    expect(markdown).toContain('…（残り 10 行）');
    expect(markdown).toContain('#### 直近コメント（最新 1 件）');
    expect(markdown).toContain('#### 関連');
    expect(markdown).toContain('#2550 closed 紐付け issue [bug]');
    expect(markdown).toContain('#### 触るファイル');
    expect(markdown).toContain('保護対象: 必要');
    expect(markdown).toContain('#### 決定ログ');
    expect(markdown).toContain('#### 関連 skill 候補');
    expect(markdown).toContain('#### 判断の記録');
    expect(markdown).toContain('DoD: あり | 分解表: なし | brief: あり');
    expect(markdown).toContain('次の一手: pnpm branch:finish 2549');
    expect(markdown).toContain(
      '判断の記録が欠けている: 分解表（routing skill 手順 1 / dispatch 手順 7）',
    );
    expect(markdown.split('\n').length).toBeLessThanOrEqual(150);
  });

  it('空セクションは丸ごと省く', () => {
    const pack = {
      number: 1,
      kind: 'issue' as const,
      header: {
        title: 'issue',
        state: 'open',
        labels: [],
        milestone: null,
        assignee: null,
        url: 'x',
      },
      body: { text: '', truncated: false, remaining: 0 },
      comments: [],
      related: { parentEpic: null, prs: null, linkedIssues: null },
      files: null,
      protectedRequired: null,
      decisionLines: [],
      skills: [],
      nextStep: '',
    };
    const markdown = renderMarkdown(pack);
    expect(markdown).not.toContain('直近コメント');
    expect(markdown).not.toContain('関連');
    expect(markdown).not.toContain('触るファイル');
    expect(markdown).not.toContain('決定ログ');
    expect(markdown).not.toContain('skill');
    expect(markdown).not.toContain('次の一手');
  });

  it('可変セクションが巨大でも 150 行以内に収め、末尾セクションは残す（150 行保証）', () => {
    const hugeBody = Array.from({ length: 200 }, (_, i) => `本文行 ${i}`).join('\n');
    const manyComments = Array.from({ length: 40 }, (_, i) => ({
      author: `user${i}`,
      date: '2026-08-01',
      body: `コメント本文 ${i}\n2 行目`,
    }));
    const manyFiles = Array.from({ length: 60 }, (_, i) => `apps/product/src/file${i}.ts`);
    const pack = {
      number: 9999,
      kind: 'pr' as const,
      header: {
        title: '巨大 PR',
        state: 'OPEN',
        labels: [],
        milestone: null,
        assignee: null,
        url: 'https://github.com/Dayopt/dayopt/pull/9999',
        headRefName: 'sonnet/huge',
        baseRefName: 'main',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        reviewDecision: null,
        ciRollup: { success: 3, failure: 0, pending: 0 },
        unresolvedThreads: 0,
      },
      body: { text: hugeBody, truncated: false, remaining: 0 },
      comments: manyComments,
      related: {
        parentEpic: null,
        prs: null,
        linkedIssues: Array.from({ length: 20 }, (_, i) => ({
          number: 3000 + i,
          state: 'open',
          title: `紐付け issue ${i}`,
          labels: [],
        })),
      },
      files: manyFiles,
      protectedRequired: true,
      decisionLines: [],
      skills: ['pr-cross-review'],
      judgmentRecords: { dod: true, breakdown: true, brief: true },
      routing: {
        level: 'L3',
        ready: false,
        preparation: 'L1',
        reasons: ['時間規則'],
        missing: ['検証コマンド'],
        preparationGoal: '根拠を整理する',
      },
      nextStep: 'pnpm branch:finish 9999',
      nextStepSecondary: null,
    };

    // この fixture は縮小しなければ 300 行を大きく超える。
    const markdown = renderMarkdown(pack);
    const lineCount = markdown.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(150);
    expect(markdown).toContain('実装・判断: L3');
    expect(markdown).toContain('不足: 検証コマンド');
    expect(markdown).toContain('#### 判断の記録');
    expect(markdown).toContain('次の一手: pnpm branch:finish 9999');
  });

  it('#2560 項目 5: 決定ログと受け入れ条件が巨大でも 150 行に収める', () => {
    // 既存の pressure test は decisionLines を空、linkedIssues に acceptanceText 無しで
    // 組んでいたため、この 2 セクションは一度も圧力下で評価されていなかった。
    const pack = {
      number: 8888,
      kind: 'pr' as const,
      header: {
        title: '決定ログが厚い PR',
        state: 'OPEN',
        labels: [],
        milestone: null,
        assignee: null,
        url: 'x',
        headRefName: 'opus/heavy',
        baseRefName: 'main',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        reviewDecision: null,
        ciRollup: { success: 1, failure: 0, pending: 0 },
        unresolvedThreads: 0,
      },
      body: {
        text: Array.from({ length: 80 }, (_, i) => `本文 ${i}`).join('\n'),
        truncated: false,
        remaining: 0,
      },
      comments: [],
      related: {
        parentEpic: null,
        prs: null,
        linkedIssues: [
          {
            number: 100,
            state: 'open',
            title: 'issue A',
            labels: [],
            acceptanceText: Array.from({ length: 60 }, (_, i) => `受け入れ条件 ${i}`).join('\n'),
          },
        ],
      },
      files: null,
      protectedRequired: null,
      // 決定ログは以前は上限が無く、全件そのまま描画されていた。
      decisionLines: Array.from({ length: 200 }, (_, i) => `- 2026-09-0${(i % 9) + 1}: 決定 ${i}`),
      skills: [],
      judgmentRecords: { dod: true, breakdown: true, brief: true },
      nextStep: 'pnpm branch:finish 8888',
      nextStepSecondary: null,
    };

    const markdown = renderMarkdown(pack);

    expect(markdown.split('\n').length).toBeLessThanOrEqual(150);
    // 末尾セクションは必ず残る。
    expect(markdown).toContain('#### 判断の記録');
    expect(markdown).toContain('次の一手: pnpm branch:finish 8888');
  });

  it('#2560 項目 5: 受け入れ条件は最終段でセクションごと落ちる（省略行だけ残さない）', () => {
    // acceptanceMaxLines を 0 まで絞った段で「…（N 行省略）」だけが残ると、
    // 段階縮小の最終段が 0 行まで縮まず 150 行を守れない場合がある。
    const pack = {
      number: 8891,
      kind: 'pr' as const,
      header: {
        title: 'x',
        state: 'OPEN',
        labels: [],
        milestone: null,
        assignee: null,
        url: 'x',
        headRefName: 'a',
        baseRefName: 'main',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        reviewDecision: null,
        ciRollup: { success: 1, failure: 0, pending: 0 },
        unresolvedThreads: 0,
      },
      body: {
        text: Array.from({ length: 400 }, (_, i) => `本文 ${i}`).join('\n'),
        truncated: false,
        remaining: 0,
      },
      comments: Array.from({ length: 60 }, (_, i) => ({
        author: `u${i}`,
        date: '2026-09-01',
        body: `c${i}`,
      })),
      related: {
        parentEpic: null,
        prs: null,
        linkedIssues: [
          {
            number: 100,
            state: 'open',
            title: 'issue A',
            labels: [],
            acceptanceText: Array.from({ length: 300 }, (_, i) => `受け入れ ${i}`).join('\n'),
          },
        ],
      },
      files: Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`),
      protectedRequired: true,
      decisionLines: Array.from({ length: 300 }, (_, i) => `- 決定 ${i}`),
      skills: [],
      judgmentRecords: { dod: true, breakdown: true, brief: true },
      nextStep: 'pnpm branch:finish 8891',
      nextStepSecondary: null,
    };

    const markdown = renderMarkdown(pack);

    expect(markdown.split('\n').length).toBeLessThanOrEqual(150);
    // 最終段まで縮んだ時は見出しごと消える（省略行だけの残骸を作らない）。
    if (!markdown.includes('#### linked issue の受け入れ条件')) {
      expect(markdown).not.toMatch(/…（\d+ 行省略）/);
    }
    expect(markdown).toContain('次の一手: pnpm branch:finish 8891');
  });

  it('#2560 項目 5: 決定ログを縮めた時は省略件数を出す', () => {
    const basePack = {
      number: 8889,
      kind: 'issue' as const,
      header: {
        title: 'issue',
        state: 'open',
        labels: [],
        milestone: null,
        assignee: null,
        url: 'x',
      },
      body: {
        text: Array.from({ length: 300 }, (_, i) => `本文 ${i}`).join('\n'),
        truncated: false,
        remaining: 0,
      },
      comments: [],
      related: { parentEpic: null, prs: null, linkedIssues: null },
      files: null,
      protectedRequired: null,
      decisionLines: Array.from({ length: 300 }, (_, i) => `- 決定 ${i}`),
      skills: [],
      nextStep: '分解表を issue コメントに書く（routing skill）',
    };

    const markdown = renderMarkdown(basePack);

    expect(markdown.split('\n').length).toBeLessThanOrEqual(150);
    expect(markdown).toMatch(/…他 \d+ 件省略（150 行上限）/);
    expect(markdown).toContain('次の一手: 分解表を issue コメントに書く（routing skill）');
  });

  it('#2560 項目 5: 末尾セクションだけで 150 行を超えるなら黙らず warn する', () => {
    const warn = vi.fn();
    const pack = {
      number: 8890,
      kind: 'issue' as const,
      header: {
        title: 'x',
        state: 'open',
        labels: [],
        milestone: null,
        assignee: null,
        url: 'x',
      },
      body: null,
      comments: [],
      related: { parentEpic: null, prs: null, linkedIssues: null },
      files: null,
      protectedRequired: null,
      decisionLines: [],
      skills: [],
      // 末尾セクションは行数としては小さいが、値自体が改行を含むと膨らむ。
      // 縮小対象が 1 つも無いこの経路が、超過版を黙って返していた異常系。
      routing: {
        level: 'L3',
        ready: false,
        preparation: 'L1',
        reasons: [Array.from({ length: 200 }, (_, i) => `理由 ${i}`).join('\n')],
        missing: [],
        preparationGoal: '整理する',
      },
      nextStep: '次の一手',
    };

    const markdown = renderMarkdown(pack, { warn });

    // 超過版でも「次の一手」は落とさない。
    expect(markdown).toContain('次の一手: 次の一手');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('150 行に収まりませんでした');
  });

  it('150 行に収まる時は warn しない', () => {
    const warn = vi.fn();
    renderMarkdown(
      {
        number: 1,
        kind: 'issue' as const,
        header: {
          title: 'x',
          state: 'open',
          labels: [],
          milestone: null,
          assignee: null,
          url: 'x',
        },
        body: { text: '短い本文', truncated: false, remaining: 0 },
        comments: [],
        related: { parentEpic: null, prs: null, linkedIssues: null },
        files: null,
        protectedRequired: null,
        decisionLines: [],
        skills: [],
        nextStep: '次の一手',
      },
      { warn },
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('PR mode: linked issue の acceptanceText を `#### linked issue の受け入れ条件` として ≤25 行で描画する', () => {
    const pack = {
      number: 3000,
      kind: 'pr' as const,
      header: {
        title: 'PR タイトル',
        state: 'OPEN',
        labels: [],
        milestone: null,
        assignee: null,
        url: 'x',
        headRefName: 'sonnet/foo',
        baseRefName: 'main',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        reviewDecision: null,
        ciRollup: { success: 1, failure: 0, pending: 0 },
        unresolvedThreads: 0,
      },
      body: { text: '本文', truncated: false, remaining: 0 },
      comments: [],
      related: {
        parentEpic: null,
        prs: null,
        linkedIssues: [
          {
            number: 100,
            state: 'open',
            title: 'issue A',
            labels: [],
            acceptanceText: '## やること\n- [ ] やる',
          },
          {
            number: 101,
            state: 'open',
            title: 'issue B（本文になし）',
            labels: [],
            acceptanceText: '',
          },
          {
            number: 102,
            state: 'open',
            title: 'issue C',
            labels: [],
            acceptanceText: Array.from({ length: 40 }, (_, i) => `行${i}`).join('\n'),
          },
          {
            number: 103,
            state: 'open',
            title: 'issue D（4 件目は表示しない）',
            labels: [],
            acceptanceText: '受け入れ条件: D',
          },
        ],
      },
      files: null,
      protectedRequired: null,
      decisionLines: [],
      skills: [],
      judgmentRecords: null,
      nextStep: '',
      nextStepSecondary: null,
    };

    const markdown = renderMarkdown(pack);
    expect(markdown).toContain('#### linked issue の受け入れ条件');

    const allLines = markdown.split('\n');
    const sectionStart = allLines.indexOf('#### linked issue の受け入れ条件');
    const afterHeading = allLines.slice(sectionStart + 1);
    const nextHeadingIdx = afterHeading.findIndex((line) => line.startsWith('#### '));
    const sectionBodyLines =
      nextHeadingIdx === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIdx);
    const ownSectionLines = ['#### linked issue の受け入れ条件', ...sectionBodyLines];
    const sectionText = sectionBodyLines.join('\n');

    expect(sectionText).toContain('#100 issue A');
    // acceptanceText が空の issue B は省く。
    expect(sectionText).not.toContain('issue B');
    // 最大 3 件までしか含めない（4 件目の issue D は出さない）。
    expect(sectionText).not.toContain('issue D');
    expect(ownSectionLines.length).toBeLessThanOrEqual(25);
  });
});

describe('buildCommentBody', () => {
  it('1 行目がマーカー、2 行目が見出し行', () => {
    const body = buildCommentBody({ number: 2550, date: '2026-09-02', markdown: '### 本文' });
    const lines = body.split('\n');
    expect(lines[0]).toBe(CTX_MARKER);
    expect(lines[1]).toBe('**brief（`pnpm ctx 2550`、2026-09-02）**');
    expect(body).toContain('### 本文');
  });
});

describe('findMarkerComment', () => {
  const authLogin = 'tomoya';

  it('マーカーで始まる、かつ author_association が信頼できる本文のコメントを見つける', () => {
    const comments = [
      { id: 1, body: '普通のコメント', author_association: 'OWNER', user: { login: authLogin } },
      {
        id: 2,
        body: `${CTX_MARKER}\n**brief（...）**`,
        author_association: 'OWNER',
        user: { login: authLogin },
      },
    ];
    expect(findMarkerComment(comments, authLogin)?.id).toBe(2);
  });

  it('無ければ null、配列でなければ null', () => {
    expect(
      findMarkerComment(
        [
          {
            id: 1,
            body: '普通のコメント',
            author_association: 'OWNER',
            user: { login: authLogin },
          },
        ],
        authLogin,
      ),
    ).toBeNull();
    expect(findMarkerComment(undefined, authLogin)).toBeNull();
  });

  it('F2: マーカーがあっても author_association が信頼できなければ見つけない（なりすまし防止）', () => {
    const comments = [
      {
        id: 1,
        body: `${CTX_MARKER}\n偽の brief`,
        author_association: 'NONE',
        user: { login: authLogin },
      },
      {
        id: 2,
        body: `${CTX_MARKER}\n本物の brief`,
        author_association: 'COLLABORATOR',
        user: { login: authLogin },
      },
    ];
    expect(findMarkerComment(comments, authLogin)?.id).toBe(2);
  });

  it('認証ユーザーと異なる login の marker コメントは対象にしない（他ユーザーの brief を誤って PATCH しない）', () => {
    const comments = [
      {
        id: 1,
        body: `${CTX_MARKER}\n他ユーザーの brief`,
        author_association: 'OWNER',
        user: { login: 'other-user' },
      },
    ];
    expect(findMarkerComment(comments, authLogin)).toBeNull();
  });

  it('authLogin が未取得（null）なら fail-open で常に null（新規作成へ倒す）', () => {
    const comments = [
      {
        id: 1,
        body: `${CTX_MARKER}\n本物の brief`,
        author_association: 'OWNER',
        user: { login: authLogin },
      },
    ];
    expect(findMarkerComment(comments, null)).toBeNull();
  });
});

describe('buildPostArgs', () => {
  it('既存コメントが有れば PATCH の argv を組む', () => {
    const { mode, argv } = buildPostArgs({ number: 2550, existingCommentId: 99, tmpFile: '/t/b' });
    expect(mode).toBe('update');
    expect(argv).toEqual([
      'api',
      '-X',
      'PATCH',
      'repos/Dayopt/dayopt/issues/comments/99',
      '-F',
      'body=@/t/b',
    ]);
  });

  it('既存コメントが無ければ新規作成の argv を組む', () => {
    const { mode, argv } = buildPostArgs({
      number: 2550,
      existingCommentId: null,
      tmpFile: '/t/b',
    });
    expect(mode).toBe('create');
    expect(argv).toEqual(['issue', 'comment', '2550', '--body-file', '/t/b']);
  });
});

describe('postContextBrief', () => {
  const pack = { number: 2550 };
  const markdown = '### #2550 タイトル';

  it('既存の ctx brief コメントが無ければ作成する', () => {
    const calls: string[][] = [];
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'user') return 'tomoya\n';
      if (args[0] === 'api') {
        return JSON.stringify([{ id: 1, body: '無関係なコメント', user: { login: 'tomoya' } }]);
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        return 'https://github.com/Dayopt/dayopt/issues/2550#issuecomment-1\n';
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const writeFileImpl = vi.fn();
    const mkdtempImpl = vi.fn(() => '/tmp/ctx-brief-xyz');

    const result = postContextBrief(pack, markdown, {
      execFileImpl,
      writeFileImpl,
      mkdtempImpl,
      now: () => new Date('2026-09-02T00:00:00Z'),
    });

    expect(result).toEqual({
      mode: 'create',
      url: 'https://github.com/Dayopt/dayopt/issues/2550#issuecomment-1',
    });
    expect(calls[0]).toEqual([
      'api',
      'repos/Dayopt/dayopt/issues/2550/comments?per_page=100',
      '--paginate',
    ]);
    expect(calls[1]).toEqual(['api', 'user', '--jq', '.login']);
    expect(calls[2]).toEqual([
      'issue',
      'comment',
      '2550',
      '--body-file',
      '/tmp/ctx-brief-xyz/body.md',
    ]);
    expect(writeFileImpl).toHaveBeenCalledWith(
      '/tmp/ctx-brief-xyz/body.md',
      expect.stringContaining(CTX_MARKER),
      'utf8',
    );
  });

  it('既存の ctx brief コメントが有れば PATCH で更新する', () => {
    const calls: string[][] = [];
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'user') return 'tomoya\n';
      if (args[0] === 'api' && args[1] !== '-X') {
        return JSON.stringify([
          {
            id: 42,
            body: `${CTX_MARKER}\n古い brief`,
            author_association: 'OWNER',
            user: { login: 'tomoya' },
          },
        ]);
      }
      if (args[0] === 'api' && args[1] === '-X') {
        return JSON.stringify({
          html_url: 'https://github.com/Dayopt/dayopt/issues/2550#issuecomment-42',
        });
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const writeFileImpl = vi.fn();
    const mkdtempImpl = vi.fn(() => '/tmp/ctx-brief-abc');

    const result = postContextBrief(pack, markdown, {
      execFileImpl,
      writeFileImpl,
      mkdtempImpl,
      now: () => new Date('2026-09-02T00:00:00Z'),
    });

    expect(result).toEqual({
      mode: 'update',
      url: 'https://github.com/Dayopt/dayopt/issues/2550#issuecomment-42',
    });
    expect(calls[2]).toEqual([
      'api',
      '-X',
      'PATCH',
      'repos/Dayopt/dayopt/issues/comments/42',
      '-F',
      'body=@/tmp/ctx-brief-abc/body.md',
    ]);
  });

  it('認証ユーザーの取得に失敗しても fail-open で新規作成する（他ユーザーの brief を誤って PATCH しない）', () => {
    const calls: string[][] = [];
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'user') throw new Error('not authenticated');
      if (args[0] === 'api') {
        return JSON.stringify([
          {
            id: 42,
            body: `${CTX_MARKER}\n他ユーザーの brief`,
            author_association: 'OWNER',
            user: { login: 'other-user' },
          },
        ]);
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        return 'https://github.com/Dayopt/dayopt/issues/2550#issuecomment-99\n';
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const writeFileImpl = vi.fn();
    const mkdtempImpl = vi.fn(() => '/tmp/ctx-brief-fail-open');

    const result = postContextBrief(pack, markdown, {
      execFileImpl,
      writeFileImpl,
      mkdtempImpl,
      now: () => new Date('2026-09-02T00:00:00Z'),
    });

    expect(result.mode).toBe('create');
  });
});
