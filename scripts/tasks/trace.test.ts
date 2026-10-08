import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_REVIEW_MARKER } from '../lib/review-policy.mjs';
import {
  buildInternalReviewSection,
  buildRevertSearchArgv,
  buildSessionRow,
  buildSessionSection,
  buildTracePack,
  collectDecisionLines,
  computeFindings,
  computeZeroFindingRoleNotes,
  countCommitsAfterMarker,
  countCommitsAfterReady,
  countCommitsAfterReadyFallback,
  countReviewPriorities,
  countReviewRequestCycles,
  countRoleFindingsHeuristic,
  extractDodExcerpt,
  filterInternalReviewMarkerComments,
  findReadyForReviewDate,
  groupFilesBySession,
  hasInternalReviewMarker,
  hasNoEditHeavyModelSession,
  hasVerificationSection,
  loadSessionEntriesForBranch,
  matchesBranch,
  parseArgs,
  parseJsonlLines,
  parseMarkerAgentField,
  parseMarkerFindingsField,
  parseMarkerHeadSha,
  parseMarkerPartialCoverageRoles,
  parseMarkerStatusField,
  renderMarkdown,
  sessionIdFromSubagentPath,
  timelineLacksCommitEvents,
} from './trace.mjs';

describe('parseArgs', () => {
  it('PR 番号のみ指定した既定値', () => {
    expect(parseArgs(['2547'])).toEqual({ number: 2547, json: false });
  });

  it('--json を解釈する', () => {
    expect(parseArgs(['2547', '--json'])).toEqual({ number: 2547, json: true });
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

describe('sessionIdFromSubagentPath / groupFilesBySession', () => {
  it('subagents ディレクトリの直上を session id とする', () => {
    expect(sessionIdFromSubagentPath('/p/abc-123/subagents/agent-1.jsonl')).toBe('abc-123');
    expect(sessionIdFromSubagentPath('/p/abc-123.jsonl')).toBeNull();
  });

  it('session file と subagent file を session id で束ねる', () => {
    const groups = groupFilesBySession([
      '/p/s1.jsonl',
      '/p/s1/subagents/agent-a.jsonl',
      '/p/s1/subagents/agent-b.jsonl',
      '/p/s2.jsonl',
    ]);
    expect(groups.get('s1')).toEqual({
      sessionFile: '/p/s1.jsonl',
      subagentFiles: ['/p/s1/subagents/agent-a.jsonl', '/p/s1/subagents/agent-b.jsonl'],
    });
    expect(groups.get('s2')).toEqual({ sessionFile: '/p/s2.jsonl', subagentFiles: [] });
  });

  it('session file の無い孤立 subagent は sessionFile: null のまま残る', () => {
    const groups = groupFilesBySession(['/p/s3/subagents/agent-a.jsonl']);
    expect(groups.get('s3')).toEqual({
      sessionFile: null,
      subagentFiles: ['/p/s3/subagents/agent-a.jsonl'],
    });
  });
});

describe('matchesBranch', () => {
  it('gitBranch が一致する record が 1 つでもあれば true', () => {
    expect(matchesBranch([{ gitBranch: 'main' }, { gitBranch: 'feat/x' }], 'feat/x')).toBe(true);
    expect(matchesBranch([{ gitBranch: 'main' }], 'feat/x')).toBe(false);
  });

  it('headRefName が無ければ false', () => {
    expect(matchesBranch([{ gitBranch: 'main' }], '')).toBe(false);
  });
});

describe('loadSessionEntriesForBranch', () => {
  it('本体の project ディレクトリ名を prefix に持つ worktree 用ディレクトリも scan する', () => {
    const rootDir = '-Users-x-dayopt';
    const worktreeDir = '-Users-x-dayopt-.claude-worktrees-foo';
    const listDirsImpl = vi.fn(() => [rootDir, worktreeDir, '-Users-x-other-repo']);
    const listFilesImpl = vi.fn((projectDir: string) => {
      if (projectDir.endsWith(rootDir)) return [`/${rootDir}/root-session.jsonl`];
      if (projectDir.endsWith(worktreeDir)) return [`/${worktreeDir}/wt-session.jsonl`];
      return [];
    });
    const readFileImpl = vi.fn((filePath: string) => {
      if (filePath.includes('root-session')) {
        return JSON.stringify({ gitBranch: 'sonnet/foo-1', timestamp: '2026-08-01T00:00:00Z' });
      }
      if (filePath.includes('wt-session')) {
        return JSON.stringify({ gitBranch: 'sonnet/foo-1', timestamp: '2026-08-02T00:00:00Z' });
      }
      throw new Error(`unexpected file: ${filePath}`);
    });

    const entries = loadSessionEntriesForBranch({
      projectsDir: '/home/.claude/projects',
      cwdPrefix: '/Users/x/dayopt',
      headRefName: 'sonnet/foo-1',
      readFileImpl,
      listFilesImpl,
      listDirsImpl,
    });

    expect(entries?.map((e) => e.sessionId).sort()).toEqual(['root-session', 'wt-session'].sort());
    // 無関係な repo のディレクトリは scan しない。
    expect(listFilesImpl).not.toHaveBeenCalledWith(expect.stringContaining('-Users-x-other-repo'));
  });

  it('一致するディレクトリが 1 つも無ければ null', () => {
    const entries = loadSessionEntriesForBranch({
      projectsDir: '/home/.claude/projects',
      cwdPrefix: '/Users/x/dayopt',
      headRefName: 'main',
      listDirsImpl: () => ['-Users-x-other-repo'],
      listFilesImpl: () => [],
    });
    expect(entries).toBeNull();
  });
});

describe('parseJsonlLines', () => {
  it('壊れた行を無視して parse する', () => {
    const raw = '{"a":1}\n\nnot json\n{"a":2}';
    expect(parseJsonlLines(raw)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('buildSessionRow / buildSessionSection', () => {
  const records = [
    {
      type: 'assistant',
      timestamp: '2026-08-01T00:00:00Z',
      message: {
        model: 'claude-sonnet',
        usage: { output_tokens: 100 },
        content: [{ type: 'tool_use', name: 'Read', id: '1' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-08-01T00:01:00Z',
      message: {
        model: 'claude-sonnet',
        usage: { output_tokens: 50 },
        content: [{ type: 'tool_use', name: 'Edit', id: '2' }],
      },
    },
  ];

  it('model 構成・tool 呼び出し数・Edit 数・探索 turn を集計する', () => {
    const row = buildSessionRow({ sessionId: 'abcdef12-xxxx', records, subagentCount: 2 });
    expect(row.sessionId).toBe('abcdef12-xxxx');
    expect(row.modelSummary).toContain('sonnet');
    expect(row.toolCalls).toBe(2);
    expect(row.editCalls).toBe(1);
    expect(row.exploreTurns).toBe(1); // Read が Edit より前に 1 回
    expect(row.subagentCount).toBe(2);
  });

  it('buildSessionSection は新しい順に並べ、最大 10 件だけ表示、summary は全件対象', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      sessionId: `s${i}`,
      records: [
        {
          type: 'assistant',
          timestamp: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          message: {
            model: 'sonnet',
            usage: { output_tokens: 10 },
            content: [{ type: 'tool_use', name: 'Edit', id: `${i}` }],
          },
        },
      ],
      subagentCount: 0,
    }));
    const { displayed, summary } = buildSessionSection(entries);
    expect(displayed).toHaveLength(10);
    expect(displayed[0].sessionId).toBe('s11'); // 最新（8/12）が先頭
    expect(summary.sessionCount).toBe(12);
    expect(summary.totalEdit).toBe(12);
  });

  it('`all` は表示上限（10 件）の外の session も含む全件（#2530 P2: 11 件目以降の高コスト無編集 session を見落とさない）', () => {
    // 12 件中、表示外（11 件目・古い方）に編集なしの opus session を混ぜる。
    const entries = Array.from({ length: 12 }, (_, i) => ({
      sessionId: `s${i}`,
      records: [
        {
          type: 'assistant',
          timestamp: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          message: {
            model: i === 0 ? 'opus' : 'sonnet',
            usage: { output_tokens: 10 },
            content:
              i === 0
                ? [] // 編集なし
                : [{ type: 'tool_use', name: 'Edit', id: `${i}` }],
          },
        },
      ],
      subagentCount: 0,
    }));
    const { displayed, all } = buildSessionSection(entries);
    expect(displayed).toHaveLength(10);
    expect(displayed.some((r: { sessionId: string }) => r.sessionId === 's0')).toBe(false);
    expect(all).toHaveLength(12);
    expect(hasNoEditHeavyModelSession(displayed)).toBe(false);
    expect(hasNoEditHeavyModelSession(all)).toBe(true);
  });
});

describe('hasNoEditHeavyModelSession', () => {
  it('編集 0 件かつ opus/fable を含む session があれば true', () => {
    expect(hasNoEditHeavyModelSession([{ editCalls: 0, modelSummary: 'opus(1.0k)' }])).toBe(true);
    expect(hasNoEditHeavyModelSession([{ editCalls: 1, modelSummary: 'opus(1.0k)' }])).toBe(false);
    expect(hasNoEditHeavyModelSession([{ editCalls: 0, modelSummary: 'sonnet(1.0k)' }])).toBe(
      false,
    );
  });
});

describe('hasVerificationSection / extractDodExcerpt', () => {
  it('## 検証 見出しの有無を判定する', () => {
    expect(hasVerificationSection('本文\n## 検証\n手順')).toBe(true);
    expect(hasVerificationSection('本文だけ')).toBe(false);
  });

  it('DoD 言及行から 3 行抜粋する', () => {
    expect(extractDodExcerpt('前置き\nDoD: XXX\n詳細1\n詳細2\n無関係')).toBe(
      'DoD: XXX\n詳細1\n詳細2',
    );
    expect(extractDodExcerpt('言及なし')).toBe('');
  });
});

describe('findReadyForReviewDate / countCommitsAfterReady / timelineLacksCommitEvents', () => {
  const timeline = [
    { event: 'ready_for_review', created_at: '2026-08-01T00:00:00Z' },
    { event: 'committed', committed_date: '2026-07-31T00:00:00Z' },
    { event: 'committed', committed_date: '2026-08-02T00:00:00Z' },
    { event: 'committed', committed_date: '2026-08-03T00:00:00Z' },
  ];

  it('ready_for_review の日時を取る', () => {
    expect(findReadyForReviewDate(timeline)).toBe('2026-08-01T00:00:00Z');
    expect(findReadyForReviewDate([])).toBeNull();
  });

  it('ready 後の committed だけ数える', () => {
    expect(countCommitsAfterReady(timeline, '2026-08-01T00:00:00Z')).toBe(2);
    expect(countCommitsAfterReady(timeline, null)).toBeNull();
  });

  it('committed event が無ければ true', () => {
    expect(timelineLacksCommitEvents([{ event: 'ready_for_review' }])).toBe(true);
    expect(timelineLacksCommitEvents(timeline)).toBe(false);
  });

  it('fallback（gh pr view --json commits）でも ready 後だけ数える', () => {
    const commits = [
      { committedDate: '2026-07-31T00:00:00Z' },
      { committedDate: '2026-08-05T00:00:00Z' },
    ];
    expect(countCommitsAfterReadyFallback(commits, '2026-08-01T00:00:00Z')).toBe(1);
  });
});

describe('countReviewPriorities', () => {
  it('P1/P2 の言及件数を Codex bot login で絞って数える（過去 PR）', () => {
    const reviews = [
      { user: { login: 'chatgpt-codex-connector' }, body: 'P1: 深刻な不具合' },
      { user: { login: 'tomoya' }, body: 'P1 だが自分のコメント' },
    ];
    const comments = [{ user: { login: 'chatgpt-codex-connector[bot]' }, body: 'P2 の指摘' }];
    expect(countReviewPriorities(reviews, comments)).toEqual({ p1: 1, p2: 1 });
  });

  it('Claude review は marker 付きの github-actions 投稿だけを数える', () => {
    const comments = [
      {
        user: { login: 'github-actions[bot]' },
        body: `${CLAUDE_REVIEW_MARKER}\n![P1 Badge](x) 指摘`,
      },
      { user: { login: 'github-actions[bot]' }, body: 'P1 を含む別 workflow の comment' },
    ];
    expect(countReviewPriorities([], comments)).toEqual({ p1: 1, p2: 0 });
  });

  it('dependabot[bot] 等の無関係な bot コメントは `[bot]` サフィックス一致だけでは誤計上しない', () => {
    const comments = [{ user: { login: 'dependabot[bot]' }, body: 'P1 のセキュリティ更新' }];
    expect(countReviewPriorities([], comments)).toEqual({ p1: 0, p2: 0 });
  });
});

describe('countReviewRequestCycles', () => {
  it('@claude review の依頼と Claude review の結果 comment を数える', () => {
    const comments = [
      { user: { login: 't3-nico' }, body: '@claude review' },
      {
        user: { login: 'github-actions[bot]' },
        body: `${CLAUDE_REVIEW_MARKER}\nResult: completed\nFindings: 2`,
      },
      { user: { login: 't3-nico' }, body: '@claude review' },
      {
        user: { login: 'github-actions[bot]' },
        body: `${CLAUDE_REVIEW_MARKER}\nResult: completed\nFindings: 0`,
      },
      { user: { login: 'github-actions[bot]' }, body: 'Deploy preview ready' },
    ];
    expect(countReviewRequestCycles(comments)).toEqual({
      requests: 2,
      responses: 2,
      cleanResponses: 1,
    });
  });
});

describe('hasInternalReviewMarker', () => {
  it('[internal-review] を含むコメントの有無', () => {
    expect(hasInternalReviewMarker([{ body: '[internal-review] 完了' }])).toBe(true);
    expect(hasInternalReviewMarker([{ body: '普通のコメント' }])).toBe(false);
  });
});

describe('filterInternalReviewMarkerComments', () => {
  it('OWNER/MEMBER/COLLABORATOR かつ本文が [internal-review] で始まるものだけ抜く', () => {
    const comments = [
      { body: '[internal-review]\nhead: a', author_association: 'OWNER' },
      { body: '[internal-review]\nhead: b', author_association: 'NONE' },
      { body: '普通のコメント', author_association: 'MEMBER' },
      { body: '前置きの後に [internal-review]', author_association: 'COLLABORATOR' },
    ];
    expect(filterInternalReviewMarkerComments(comments)).toEqual([comments[0]]);
  });

  it('issueComments が null/空でも例外にならない', () => {
    expect(filterInternalReviewMarkerComments(null)).toEqual([]);
    expect(filterInternalReviewMarkerComments([])).toEqual([]);
  });
});

describe('parseMarkerAgentField', () => {
  it('カンマ区切りの role を status ok で分解する', () => {
    expect(parseMarkerAgentField('agent: risk-reviewer, behavior-verifier')).toEqual([
      { role: 'risk-reviewer', status: 'ok' },
      { role: 'behavior-verifier', status: 'ok' },
    ]);
  });

  it('(text-fallback) 注釈を status へ反映する', () => {
    expect(
      parseMarkerAgentField('agent: risk-reviewer(text-fallback), architecture-guard'),
    ).toEqual([
      { role: 'risk-reviewer', status: 'text-fallback' },
      { role: 'architecture-guard', status: 'ok' },
    ]);
  });

  it('agent 行が無ければ空配列', () => {
    expect(parseMarkerAgentField('head: abc')).toEqual([]);
  });
});

describe('parseMarkerPartialCoverageRoles', () => {
  it('partial coverage 行から role 名だけを抜く（注釈は除外）', () => {
    const body =
      'partial coverage: risk-reviewer, behavior-verifier（diff 該当箇所を目視確認済み）';
    expect(parseMarkerPartialCoverageRoles(body)).toEqual(['risk-reviewer', 'behavior-verifier']);
  });

  it('行が無ければ空配列', () => {
    expect(parseMarkerPartialCoverageRoles('head: abc')).toEqual([]);
  });
});

describe('parseMarkerStatusField', () => {
  it('known role の portable review status を読む', () => {
    expect(
      parseMarkerStatusField(
        'status: risk-reviewer=reviewed, behavior-verifier=partial, architecture-guard=not-run',
      ),
    ).toEqual({
      'risk-reviewer': 'reviewed',
      'behavior-verifier': 'partial',
      'architecture-guard': 'not-run',
    });
  });

  it('unknown role / status と status 行なしを無視する', () => {
    expect(parseMarkerStatusField('status: risk-reviewer=unknown, other=reviewed')).toEqual({
      'risk-reviewer': 'invalid',
    });
    expect(parseMarkerStatusField('agent: risk-reviewer')).toEqual({});
  });
});

describe('parseMarkerHeadSha', () => {
  it('40 桁 hex を取る', () => {
    const sha = 'a'.repeat(40);
    expect(parseMarkerHeadSha(`head: ${sha}`)).toBe(sha);
  });

  it('無ければ null', () => {
    expect(parseMarkerHeadSha('head: short')).toBeNull();
  });
});

describe('parseMarkerFindingsField', () => {
  it('role=件数(P1 x/P2 y) 形式を role 別の件数へ分解する', () => {
    const body = 'findings: risk-reviewer=2(P1 1/P2 1), behavior-verifier=0';
    expect(parseMarkerFindingsField(body)).toEqual({
      'risk-reviewer': 2,
      'behavior-verifier': 0,
    });
  });

  it('role(text-fallback)=不明 は null にする（件数を主張しない）', () => {
    const body = 'findings: architecture-guard(text-fallback)=不明, risk-reviewer=1(P1 1/P2 0)';
    expect(parseMarkerFindingsField(body)).toEqual({
      'architecture-guard': null,
      'risk-reviewer': 1,
    });
  });

  it('findings: 行が無ければ空オブジェクト（古い marker との後方互換）', () => {
    expect(parseMarkerFindingsField('head: abc\nagent: risk-reviewer\nP1: なし\nP2: なし')).toEqual(
      {},
    );
  });
});

describe('countCommitsAfterMarker', () => {
  it('marker の created_at より後の commit だけ数える', () => {
    const commits = [
      { committedDate: '2026-08-01T00:00:00Z' },
      { committedDate: '2026-08-03T00:00:00Z' },
    ];
    expect(countCommitsAfterMarker(commits, '2026-08-02T00:00:00Z')).toBe(1);
  });

  it('markerCreatedAt が無ければ null', () => {
    expect(countCommitsAfterMarker([{ committedDate: '2026-08-01T00:00:00Z' }], null)).toBeNull();
  });
});

describe('countRoleFindingsHeuristic', () => {
  it('role 名を含む review/issue comment 件数を数える（大文字小文字無視）', () => {
    const reviewComments = [{ body: 'RISK-REVIEWER の指摘: 権限漏れ' }, { body: '無関係' }];
    const issueComments = [{ body: 'behavior-verifier が見つけた回帰' }];
    expect(countRoleFindingsHeuristic('risk-reviewer', reviewComments, issueComments)).toBe(1);
    expect(countRoleFindingsHeuristic('behavior-verifier', reviewComments, issueComments)).toBe(1);
    expect(countRoleFindingsHeuristic('architecture-guard', reviewComments, issueComments)).toBe(0);
  });
});

describe('buildInternalReviewSection', () => {
  it('marker が無ければ null', () => {
    expect(
      buildInternalReviewSection({ issueComments: [], reviewComments: [], commits: [] }),
    ).toBeNull();
  });

  it('最新 marker の role 構成・coverage・findings・marker 後 commit を組み立てる', () => {
    const sha = 'a'.repeat(40);
    const markerBody = [
      '[internal-review]',
      `head: ${sha}`,
      'agent: risk-reviewer, behavior-verifier(text-fallback)',
      'P1: なし',
      'P2: 1 件（review comment 参照）',
      'partial coverage: risk-reviewer（diff 該当箇所を目視確認済み）',
    ].join('\n');
    const issueComments = [
      { body: markerBody, author_association: 'OWNER', created_at: '2026-08-10T00:00:00Z' },
      { body: 'risk-reviewer が指摘した権限漏れ' },
    ];
    const reviewComments = [{ body: 'behavior-verifier の指摘: cache 競合' }];
    const commits = [
      { committedDate: '2026-08-09T00:00:00Z' },
      { committedDate: '2026-08-11T00:00:00Z' },
    ];

    expect(buildInternalReviewSection({ issueComments, reviewComments, commits })).toEqual({
      markerCount: 1,
      latestMarkerCreatedAt: '2026-08-10T00:00:00Z',
      latestHeadSha: sha,
      roles: [
        {
          role: 'risk-reviewer',
          status: 'stale',
          coverage: 'partial',
          findings: null,
          findingsSource: 'status',
          totalFindings: null,
          totalFindingsEstimated: true,
          commitsAfterMarker: 1,
        },
        {
          role: 'behavior-verifier',
          status: 'stale',
          coverage: 'complete',
          findings: null,
          findingsSource: 'status',
          totalFindings: null,
          totalFindingsEstimated: true,
          commitsAfterMarker: 1,
        },
      ],
    });
  });

  it('findings: 行があれば marker の値を authoritative として使い、ヒューリスティックと食い違っても marker を優先する', () => {
    const sha = 'b'.repeat(40);
    const markerBody = [
      '[internal-review]',
      `head: ${sha}`,
      'agent: risk-reviewer, behavior-verifier, architecture-guard(text-fallback)',
      'findings: risk-reviewer=2(P1 1/P2 1), behavior-verifier=0, architecture-guard(text-fallback)=不明',
      'P1: 1 件（review comment 参照）',
      'P2: 1 件（review comment 参照）',
    ].join('\n');
    const issueComments = [
      { body: markerBody, author_association: 'OWNER', created_at: '2026-08-20T00:00:00Z' },
      // ヒューリスティックだけなら risk-reviewer=1・architecture-guard=1 になる
      // 部分一致（marker 自身は除外済みなので二重計上しない）が、findings: 行が
      // あるので risk-reviewer は marker の 2 を使う。architecture-guard は
      // text-fallback で完了を証明できないため未集計にする。
      { body: 'risk-reviewer が指摘した権限漏れ' },
      { body: 'architecture-guard の指摘: barrel 逸脱' },
    ];

    const result = buildInternalReviewSection({ issueComments, reviewComments: [], commits: [] });

    expect(result?.roles).toEqual([
      {
        role: 'risk-reviewer',
        status: 'ok',
        coverage: 'complete',
        findings: 2,
        findingsSource: 'marker',
        totalFindings: 2,
        totalFindingsEstimated: false,
        commitsAfterMarker: 0,
      },
      {
        role: 'behavior-verifier',
        status: 'ok',
        coverage: 'complete',
        findings: 0,
        findingsSource: 'marker',
        totalFindings: 0,
        totalFindingsEstimated: false,
        commitsAfterMarker: 0,
      },
      {
        role: 'architecture-guard',
        status: 'text-fallback',
        coverage: 'complete',
        findings: null,
        findingsSource: 'status',
        totalFindings: null,
        totalFindingsEstimated: true,
        commitsAfterMarker: 0,
      },
    ]);
  });

  it('複数 marker の findings を role ごとに合算する（round1=2, round2=0 → 合計 2）', () => {
    const round1Body = [
      '[internal-review]',
      `head: ${'c'.repeat(40)}`,
      'agent: risk-reviewer',
      'findings: risk-reviewer=2(P1 1/P2 1)',
      'P1: 1 件（review comment 参照）',
      'P2: 1 件（review comment 参照）',
    ].join('\n');
    const round2Body = [
      '[internal-review]',
      `head: ${'d'.repeat(40)}`,
      'agent: risk-reviewer',
      'findings: risk-reviewer=0',
      'P1: なし',
      'P2: なし',
    ].join('\n');
    const issueComments = [
      { body: round1Body, author_association: 'OWNER', created_at: '2026-08-10T00:00:00Z' },
      { body: round2Body, author_association: 'OWNER', created_at: '2026-08-12T00:00:00Z' },
    ];

    const result = buildInternalReviewSection({ issueComments, reviewComments: [], commits: [] });

    expect(result?.markerCount).toBe(2);
    expect(result?.roles).toEqual([
      {
        role: 'risk-reviewer',
        status: 'ok',
        coverage: 'complete',
        findings: 0,
        findingsSource: 'marker',
        totalFindings: 2,
        totalFindingsEstimated: false,
        commitsAfterMarker: 0,
      },
    ]);
    // 最新 marker が 0 件でも合計が非ゼロなので歩留まりゼロ扱いにしない。
    expect(computeZeroFindingRoleNotes(result, true)).toEqual([]);
  });

  it('docs-only 等 known role を含まない agent 行なら roles は空配列', () => {
    const issueComments = [
      {
        body: '[internal-review]\nhead: b\nagent: docs-only\nP1: なし\nP2: なし',
        author_association: 'OWNER',
        created_at: '2026-08-10T00:00:00Z',
      },
    ];
    const result = buildInternalReviewSection({ issueComments, reviewComments: [], commits: [] });
    expect(result?.markerCount).toBe(1);
    expect(result?.roles).toEqual([]);
  });

  it('partial / not-run / stale / invalid は findings 0 や歩留まり 0 にしない', () => {
    for (const status of ['partial', 'not-run', 'stale', 'invalid']) {
      const issueComments = [
        {
          body: [
            '[review-summary]',
            `head: ${'e'.repeat(40)}`,
            'agent: risk-reviewer',
            `status: risk-reviewer=${status}`,
            'findings: risk-reviewer=0',
          ].join('\n'),
          author_association: 'OWNER',
          created_at: '2026-08-10T00:00:00Z',
        },
      ];
      const result = buildInternalReviewSection({ issueComments, reviewComments: [], commits: [] });

      expect(result?.roles[0]).toMatchObject({
        status,
        findings: null,
        findingsSource: 'status',
        totalFindings: null,
      });
      expect(computeZeroFindingRoleNotes(result, true)).toEqual([]);
    }
  });

  it('explicit reviewed でも marker head が現在 head と違えば stale', () => {
    const markerHead = '1'.repeat(40);
    const currentHead = '2'.repeat(40);
    const issueComments = [
      {
        body: [
          '[review-summary]',
          `head: ${markerHead}`,
          'agent: risk-reviewer',
          'status: risk-reviewer=reviewed',
          'findings: risk-reviewer=0',
        ].join('\n'),
        author_association: 'OWNER',
        created_at: '2026-08-10T00:00:00Z',
      },
    ];

    const result = buildInternalReviewSection({
      issueComments,
      reviewComments: [],
      commits: [],
      headSha: currentHead,
    });

    expect(result?.roles[0]).toMatchObject({ status: 'stale', totalFindings: null });
    expect(computeZeroFindingRoleNotes(result, true)).toEqual([]);
  });

  it('known role の未知 status は legacy ok へ戻さず invalid', () => {
    const sha = '3'.repeat(40);
    const issueComments = [
      {
        body: [
          '[review-summary]',
          `head: ${sha}`,
          'agent: risk-reviewer',
          'status: risk-reviewer=timed-out',
          'findings: risk-reviewer=0',
        ].join('\n'),
        author_association: 'OWNER',
        created_at: '2026-08-10T00:00:00Z',
      },
    ];

    const result = buildInternalReviewSection({
      issueComments,
      reviewComments: [],
      commits: [],
      headSha: sha,
    });

    expect(result?.roles[0]).toMatchObject({ status: 'invalid', totalFindings: null });
  });

  it('過去 round が partial なら最新 reviewed 0 でも total は未集計', () => {
    const oldHead = '4'.repeat(40);
    const currentHead = '5'.repeat(40);
    const issueComments = [
      {
        body: [
          '[review-summary]',
          `head: ${oldHead}`,
          'agent: risk-reviewer',
          'status: risk-reviewer=partial',
          'findings: risk-reviewer=0',
        ].join('\n'),
        author_association: 'OWNER',
        created_at: '2026-08-10T00:00:00Z',
      },
      {
        body: [
          '[review-summary]',
          `head: ${currentHead}`,
          'agent: risk-reviewer',
          'status: risk-reviewer=reviewed',
          'findings: risk-reviewer=0',
        ].join('\n'),
        author_association: 'OWNER',
        created_at: '2026-08-11T00:00:00Z',
      },
    ];

    const result = buildInternalReviewSection({
      issueComments,
      reviewComments: [],
      commits: [],
      headSha: currentHead,
    });

    expect(result?.roles[0]).toMatchObject({
      status: 'reviewed',
      findings: 0,
      totalFindings: null,
    });
    expect(computeZeroFindingRoleNotes(result, true)).toEqual([]);
  });

  it('reviewed でも findings が不明なら heuristic で 0 にせず未集計', () => {
    const sha = '6'.repeat(40);
    const issueComments = [
      {
        body: [
          '[review-summary]',
          `head: ${sha}`,
          'agent: risk-reviewer',
          'status: risk-reviewer=reviewed',
          'findings: risk-reviewer=不明',
        ].join('\n'),
        author_association: 'OWNER',
        created_at: '2026-08-10T00:00:00Z',
      },
    ];

    const result = buildInternalReviewSection({
      issueComments,
      reviewComments: [],
      commits: [],
      headSha: sha,
    });

    expect(result?.roles[0]).toMatchObject({
      status: 'reviewed',
      findings: null,
      findingsSource: 'status',
      totalFindings: null,
    });
    expect(computeZeroFindingRoleNotes(result, true)).toEqual([]);
  });
});

describe('computeZeroFindingRoleNotes', () => {
  it('指摘 0 件の role かつ merged なら所見行を返す', () => {
    const internalReview = {
      markerCount: 1,
      roles: [
        {
          role: 'risk-reviewer',
          status: 'ok',
          coverage: 'complete',
          findings: 0,
          totalFindings: 0,
          commitsAfterMarker: 0,
        },
        {
          role: 'behavior-verifier',
          status: 'ok',
          coverage: 'complete',
          findings: 2,
          totalFindings: 2,
          commitsAfterMarker: 0,
        },
      ],
    };
    expect(computeZeroFindingRoleNotes(internalReview, true)).toEqual([
      'risk-reviewer: 指摘ゼロの role: 月次で scope・費用・独立性を見直し、縮小 / 廃止 / 別手段の候補にする（gardening 手順 4）',
    ]);
  });

  it('merged でなければ空配列', () => {
    const internalReview = {
      markerCount: 1,
      roles: [
        {
          role: 'risk-reviewer',
          status: 'ok',
          coverage: 'complete',
          findings: 0,
          totalFindings: 0,
          commitsAfterMarker: 0,
        },
      ],
    };
    expect(computeZeroFindingRoleNotes(internalReview, false)).toEqual([]);
  });

  it('internalReview が null なら空配列', () => {
    expect(computeZeroFindingRoleNotes(null, true)).toEqual([]);
  });

  it('最新 marker が 0 件でも、前 round の marker を合算した totalFindings が非ゼロなら所見を出さない（#2530 P2 再発防止）', () => {
    // round 1 で 2 件・round 2（re-review）で 0 件の role を「指摘ゼロ」と
    // 誤認しないことを確認する。totalFindings は buildInternalReviewSection が
    // 全 marker を合算して算出する値。
    const internalReview = {
      markerCount: 2,
      roles: [
        {
          role: 'risk-reviewer',
          status: 'ok',
          coverage: 'complete',
          findings: 0,
          findingsSource: 'marker',
          totalFindings: 2,
          totalFindingsEstimated: false,
          commitsAfterMarker: 0,
        },
      ],
    };
    expect(computeZeroFindingRoleNotes(internalReview, true)).toEqual([]);
  });
});

describe('buildRevertSearchArgv', () => {
  it('gh pr list --search の argv を組む', () => {
    expect(buildRevertSearchArgv(2547)).toEqual([
      'pr',
      'list',
      '--repo',
      'Dayopt/dayopt',
      '--state',
      'all',
      '--search',
      'Revert #2547 in:title,body',
      '--json',
      'number,title',
    ]);
  });
});

describe('collectDecisionLines', () => {
  it('番号群のいずれかを含む行だけ抜く', () => {
    const raw = '- 2026-08-01 #1 の決定\n- 2026-08-02 #2 の決定\n- 無関係';
    expect(collectDecisionLines(raw, [1])).toEqual(['- 2026-08-01 #1 の決定']);
  });

  it('raw が null なら空配列', () => {
    expect(collectDecisionLines(null, [1])).toEqual([]);
  });
});

describe('computeFindings', () => {
  it('探索 turn 中央値が 10 超えなら選別漏れを疑う', () => {
    expect(computeFindings({ exploreMedian: 11 })).toContain(
      '探索 turn が多い: brief（ctx --post）の選別漏れを疑う',
    );
    expect(computeFindings({ exploreMedian: 10 })).toEqual([]);
  });

  it('Codex P1 > 0 なら判断の記録の穴を疑う', () => {
    expect(computeFindings({ codexP1: 1 })).toContain(
      'レビューが P1 を拾った: 判断の記録（DoD / 分解表）に穴が無いか',
    );
  });

  it('ready 後 commit が 3 超えならセルフレビュー範囲を疑う', () => {
    expect(computeFindings({ commitsAfterReady: 4 })).toContain(
      'ready 後の push が多い: push 前セルフレビューの範囲を見直す',
    );
    expect(computeFindings({ commitsAfterReady: 3 })).toEqual([]);
  });

  it('編集なしの opus/fable session は Claude Code telemetry の確認候補', () => {
    expect(computeFindings({ hasNoEditHeavyModel: true })).toContain(
      'Claude Code telemetry: 編集なしの Opus / Fable session あり（用途と費用を個別確認）',
    );
  });

  it('未収集の Codex P1 は 0 件として扱わない', () => {
    expect(computeFindings({ codexP1: null })).toEqual([]);
  });

  it('どれにも当てはまらなければ空配列', () => {
    expect(computeFindings({})).toEqual([]);
  });
});

describe('renderMarkdown', () => {
  it('固定 fixture で全セクションを描画し 120 行以内に収める', () => {
    const pack = {
      number: 2547,
      header: {
        title: 'PR タイトル',
        state: 'MERGED',
        isDraft: false,
        mergedAt: '2026-08-15T00:00:00Z',
        closedAt: null,
        headRefName: 'sonnet/foo-2547',
        baseRefName: 'main',
        linkedIssues: [2540],
      },
      sessions: {
        displayed: [
          {
            sessionId: 'abcdef12-xxxx',
            startLabel: '2026-08-14 10:00',
            modelSummary: 'sonnet(120.0k)',
            toolCalls: 20,
            editCalls: 5,
            exploreTurns: 3,
            subagentCount: 1,
          },
        ],
        summary: {
          sessionCount: 1,
          modelTotals: new Map([['sonnet', 120000]]),
          totalEdit: 5,
          exploreMedian: 3,
        },
      },
      judgment: {
        issues: [
          {
            number: 2540,
            records: { dod: true, breakdown: true, brief: true },
            dodExcerpt: 'DoD: XXX',
          },
        ],
        hasVerificationSection: true,
      },
      review: {
        readyDate: '2026-08-14T00:00:00Z',
        commitsAfterReady: 1,
        codex: { p1: 0, p2: 1 },
        unresolvedThreads: 0,
        hasMarker: true,
      },
      result: {
        merged: true,
        revertCount: 0,
        decisionLines: ['2026-08-15 #2547 の決定ログ行'],
        dodBlock: { dodText: 'DoD: XXX', prBodyHead: 'PR 本文冒頭' },
      },
      findings: ['レビューが P1 を拾った: 判断の記録（DoD / 分解表）に穴が無いか'],
    };

    const markdown = renderMarkdown(pack);
    expect(markdown).toContain('### trace #2547 PR タイトル');
    expect(markdown).toContain('sonnet/foo-2547 → main');
    expect(markdown).toContain('linked issues: #2540');
    expect(markdown).toContain('#### 見た・実行（session）');
    expect(markdown).toContain('Claude Code の local transcript のみ');
    expect(markdown).toContain('Codex / Antigravity は未収集（不明であり 0 ではない）');
    expect(markdown).toContain('PR / review / merge 情報は GitHub 由来の repo 全体');
    expect(markdown).toContain('abcdef12');
    expect(markdown).toContain('#### 判断');
    expect(markdown).toContain('DoD: あり | 分解表: あり | brief: あり');
    expect(markdown).toContain('#### レビュー');
    expect(markdown).toContain('P1 0 / P2 1');
    expect(markdown).toContain('#### 結果');
    expect(markdown).toContain('判定は人が行う');
    expect(markdown).toContain('#### 所見');
    expect(markdown.split('\n').length).toBeLessThanOrEqual(120);
  });

  it('sessions が null なら未取得と表示する', () => {
    const pack = {
      number: 1,
      header: {
        title: 't',
        state: 'OPEN',
        isDraft: true,
        mergedAt: null,
        closedAt: null,
        headRefName: 'x',
        baseRefName: 'main',
        linkedIssues: [],
      },
      sessions: null,
      judgment: null,
      review: null,
      result: null,
      findings: [],
    };
    const markdown = renderMarkdown(pack);
    expect(markdown).toContain('未取得（Claude Code session log の走査に失敗');
    expect(markdown).not.toContain('#### 判断');
    expect(markdown).not.toContain('#### 所見');
  });
});

describe('buildTracePack (execFileImpl 経由の gh 呼び出し形)', () => {
  it('gh 全滅でも例外にせず未取得の pack を返す', () => {
    const execFileImpl = vi.fn(() => {
      throw new Error('gh not found');
    });
    const pack = buildTracePack(
      { number: 1 },
      {
        execFileImpl,
        readFileImpl: () => {
          throw new Error('no file');
        },
        listFilesImpl: () => null,
      },
    );
    expect(pack.header.title).toBeNull();
    expect(pack.sessions).toBeNull();
    expect(pack.sessionTelemetryCoverage.providers.codex).toBeNull();
    expect(pack.sessionTelemetryCoverage.providers.antigravity).toBeNull();
    expect(pack.review.codex).toBeNull();
    expect(pack.result.merged).toBeNull();
  });

  it('pr view → timeline → reviews/comments → graphql の argv 形を渡す', () => {
    const calls: string[][] = [];
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 2547,
          title: 'PR タイトル',
          state: 'MERGED',
          isDraft: false,
          mergedAt: '2026-08-15T00:00:00Z',
          closedAt: null,
          headRefName: 'sonnet/foo-2547',
          headRefOid: '7'.repeat(40),
          baseRefName: 'main',
          body: 'Closes #2540',
          commits: [],
        });
      }
      if (args[0] === 'api' && String(args[1]).includes('/timeline')) {
        return JSON.stringify([
          { event: 'ready_for_review', created_at: '2026-08-14T00:00:00Z' },
          { event: 'committed', committed_date: '2026-08-14T12:00:00Z' },
        ]);
      }
      if (args[0] === 'api' && String(args[1]).includes('/pulls/2547/reviews')) {
        return JSON.stringify([]);
      }
      if (args[0] === 'api' && String(args[1]).includes('/pulls/2547/comments')) {
        return JSON.stringify([]);
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/2547/comments')) {
        expect(args).toContain('--paginate');
        return JSON.stringify([]);
      }
      if (args[0] === 'api' && args[1] === 'repos/Dayopt/dayopt/issues/2540') {
        return JSON.stringify({ body: 'DoD: 完了条件' });
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/2540/comments')) {
        return JSON.stringify([]);
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([]);
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const pack = buildTracePack(
      { number: 2547 },
      {
        execFileImpl,
        readFileImpl: () => {
          throw new Error('no decisions file');
        },
        listFilesImpl: () => [],
      },
    );

    expect(pack.header.headRefName).toBe('sonnet/foo-2547');
    expect(pack.header.headRefOid).toBe('7'.repeat(40));
    expect(pack.header.linkedIssues).toEqual([2540]);
    expect(pack.review.readyDate).toBe('2026-08-14T00:00:00Z');
    expect(pack.review.commitsAfterReady).toBe(1);
    expect(pack.result.merged).toBe(true);
    expect(calls[0]).toEqual([
      'pr',
      'view',
      '2547',
      '--json',
      'number,title,state,url,isDraft,mergedAt,closedAt,headRefName,headRefOid,baseRefName,body,commits',
    ]);
  });
});

// ── #2560 項目 2 / 4: 走査範囲と推定の多重加算 ────────────────────────
describe('loadSessionEntriesForBranch の走査範囲（#2560 項目 2）', () => {
  it('prefix が一致するだけの兄弟 repo は scan しない', () => {
    const listFilesImpl = vi.fn((_projectDir: string) => ['/x/session.jsonl']);
    loadSessionEntriesForBranch({
      projectsDir: '/home/.claude/projects',
      cwdPrefix: '/Users/x/dayopt',
      headRefName: 'sonnet/foo-1',
      listDirsImpl: () => ['-Users-x-dayopt', '-Users-x-dayopt-web', '-Users-x-dayopt2'],
      listFilesImpl,
      readFileImpl: () => JSON.stringify({ gitBranch: 'sonnet/foo-1' }),
    });

    const scanned = listFilesImpl.mock.calls.map((call) => call[0]);
    expect(scanned).toEqual(['/home/.claude/projects/-Users-x-dayopt']);
  });

  it('branch 名を含まない session file は parse せずに落とす（全 parse を避ける）', () => {
    const readFileImpl = vi.fn((filePath: string) =>
      filePath.includes('hit')
        ? JSON.stringify({ gitBranch: 'sonnet/foo-1', timestamp: '2026-08-01T00:00:00Z' })
        : JSON.stringify({ gitBranch: 'other/branch' }),
    );

    const entries = loadSessionEntriesForBranch({
      projectsDir: '/home/.claude/projects',
      cwdPrefix: '/Users/x/dayopt',
      headRefName: 'sonnet/foo-1',
      listDirsImpl: () => ['-Users-x-dayopt'],
      listFilesImpl: () => ['/p/hit.jsonl', '/p/miss.jsonl'],
      readFileImpl,
    });

    expect(entries?.map((e) => e.sessionId)).toEqual(['hit']);
  });
});

describe('totalFindings の推定は 1 回だけ足す（#2560 項目 4）', () => {
  it('findings: 行の無い marker が複数あっても推定を多重加算しない', () => {
    const markerBody = (head: string) =>
      ['[review-summary]', `head: ${head}`, 'agent: risk-reviewer', 'P1: なし', 'P2: なし'].join(
        '\n',
      );
    const issueComments = [
      {
        body: markerBody('c'.repeat(40)),
        author_association: 'OWNER',
        created_at: '2026-08-10T00:00:00Z',
      },
      {
        body: markerBody('d'.repeat(40)),
        author_association: 'OWNER',
        created_at: '2026-08-11T00:00:00Z',
      },
      {
        body: markerBody('e'.repeat(40)),
        author_association: 'OWNER',
        created_at: '2026-08-12T00:00:00Z',
      },
    ];
    // ヒューリスティック推定の材料（role 名を含む review comment 1 件）。
    const reviewComments = [{ body: 'risk-reviewer の指摘: ここが危ない' }];

    const result = buildInternalReviewSection({ issueComments, reviewComments, commits: [] });

    // 旧実装は marker 3 件 × 推定 1 = 3 になっていた。
    expect(result?.roles[0].totalFindings).toBe(1);
    expect(result?.roles[0].totalFindingsEstimated).toBe(true);
  });
});

describe('レビュー summary marker の新旧書式（#2562）', () => {
  it('`[review-summary]` と旧 `[internal-review]` の両方を分析対象として拾う', () => {
    const comments = [
      { body: '[review-summary]\nhead: x\nagent: risk-reviewer', author_association: 'OWNER' },
      { body: '[internal-review]\nhead: y\nagent: risk-reviewer', author_association: 'MEMBER' },
      { body: 'ただのコメント', author_association: 'OWNER' },
      { body: '[review-summary]\n第三者', author_association: 'NONE' },
    ];
    expect(filterInternalReviewMarkerComments(comments)).toHaveLength(2);
  });
});
