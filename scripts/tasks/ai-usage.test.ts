import { describe, expect, it, vi } from 'vitest';

import {
  aggregateExplorationBeforeEdit,
  aggregateMainSessions,
  collectL0Candidates,
  collectToolResultSizes,
  computeExplorationBeforeEdit,
  computeMainSessionStats,
  createAggregate,
  defaultWindow,
  extractBashPrefix,
  fetchMergedPrStats,
  foldUsageRecord,
  getRepoRoot,
  human,
  isSubagentFilePath,
  normalizeModelLabel,
  parseArgs,
  renderMarkdown,
  SESSION_TELEMETRY_COVERAGE,
} from './ai-usage.mjs';

describe('session telemetry coverage', () => {
  it('Claude Code だけを collected とし、未収集 provider を 0 にしない', () => {
    expect(SESSION_TELEMETRY_COVERAGE.providers).toEqual({
      claudeCode: 'collected',
      codex: null,
      antigravity: null,
    });
    expect(SESSION_TELEMETRY_COVERAGE.missingMeans).toBe('unknown-not-zero');
  });
});

describe('normalizeModelLabel', () => {
  it('haiku/sonnet/opus/fable/mythos の部分一致で畳む', () => {
    expect(normalizeModelLabel('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(normalizeModelLabel('claude-sonnet-4-5')).toBe('sonnet');
    expect(normalizeModelLabel('claude-opus-4-1')).toBe('opus');
    expect(normalizeModelLabel('fable-preview')).toBe('fable');
    expect(normalizeModelLabel('mythos-x')).toBe('mythos');
  });

  it('<synthetic> のような内部レコードは除外する', () => {
    expect(normalizeModelLabel('<synthetic>')).toBeNull();
  });

  it('未知の model 名は先頭 24 文字へ倒す', () => {
    expect(normalizeModelLabel('some-unknown-model-name-that-is-long')).toBe(
      'some-unknown-model-name-',
    );
  });

  it('空値は null', () => {
    expect(normalizeModelLabel(undefined)).toBeNull();
    expect(normalizeModelLabel('')).toBeNull();
  });
});

describe('extractBashPrefix', () => {
  it('先頭の cd <path> && を 1 回だけ剥がす', () => {
    expect(extractBashPrefix('cd /repo && pnpm test')).toBe('pnpm test');
  });

  it('pnpm/npx/gh/git は 2 token を prefix にする', () => {
    expect(extractBashPrefix('pnpm run typecheck')).toBe('pnpm run');
    expect(extractBashPrefix('git status --porcelain')).toBe('git status');
    expect(extractBashPrefix('gh pr list --repo x')).toBe('gh pr');
    expect(extractBashPrefix('npx tsc --noEmit')).toBe('npx tsc');
  });

  it('それ以外は先頭 1 token', () => {
    expect(extractBashPrefix('rg -n foo')).toBe('rg');
    expect(extractBashPrefix('ls -la')).toBe('ls');
  });

  it('空文字列 / 非文字列は null', () => {
    expect(extractBashPrefix('')).toBeNull();
    expect(extractBashPrefix(undefined)).toBeNull();
  });

  it('cd <path> の後が改行区切りでも剥がす（実測で最頻出の形）', () => {
    expect(extractBashPrefix('cd /Users/tanakatomoya/Desktop/dayopt\npnpm test')).toBe('pnpm test');
  });

  it('クォート付きで空白を含む path も剥がす', () => {
    expect(extractBashPrefix('cd "$(git rev-parse --show-toplevel)" && pnpm test')).toBe(
      'pnpm test',
    );
    expect(extractBashPrefix("cd '/path with space' && pnpm test")).toBe('pnpm test');
  });

  it('剥がした後にコメント行・空行があれば読み飛ばす', () => {
    expect(extractBashPrefix('cd /repo\n# setup\npnpm test')).toBe('pnpm test');
    expect(extractBashPrefix('cd /repo && \n\n# comment\npnpm test')).toBe('pnpm test');
  });

  it('コマンド全体が cd <path> だけなら null（後続コマンドが無い）', () => {
    expect(extractBashPrefix('cd /Users/tanakatomoya/Desktop/dayopt')).toBeNull();
    expect(extractBashPrefix('cd "$(git rev-parse --show-toplevel)"')).toBeNull();
  });
});

describe('defaultWindow', () => {
  it('前月の暦月を返す', () => {
    expect(defaultWindow(new Date(Date.UTC(2026, 8, 2)))).toEqual({
      since: '2026-08-01',
      until: '2026-08-31',
    });
  });

  it('1 月始まりでも前年 12 月へ繰り下がる', () => {
    expect(defaultWindow(new Date(Date.UTC(2026, 0, 15)))).toEqual({
      since: '2025-12-01',
      until: '2025-12-31',
    });
  });
});

describe('parseArgs', () => {
  it('既定 = 前月暦月・json=false', () => {
    const options = parseArgs([], new Date(Date.UTC(2026, 8, 2)));
    expect(options).toMatchObject({ since: '2026-08-01', until: '2026-08-31', json: false });
  });

  it('--since / --until / --json / --cwd-prefix を解釈する', () => {
    const options = parseArgs([
      '--since',
      '2026-01-01',
      '--until',
      '2026-01-31',
      '--json',
      '--cwd-prefix',
      '/repo',
    ]);
    expect(options).toEqual({
      since: '2026-01-01',
      until: '2026-01-31',
      json: true,
      cwdPrefix: '/repo',
    });
  });

  it('未知の引数・不正な日付は例外', () => {
    expect(() => parseArgs(['--foo'])).toThrow(/未知の引数/);
    expect(() => parseArgs(['--since', 'not-a-date'])).toThrow(/YYYY-MM-DD/);
  });

  it('実在しない日付（例: 2 月 31 日）は Date.UTC の自動繰り上げに頼らず拒否する', () => {
    expect(() => parseArgs(['--since', '2026-02-31', '--until', '2026-03-31'])).toThrow(
      /実在する日付/,
    );
    expect(() => parseArgs(['--since', '2026-01-01', '--until', '2026-02-30'])).toThrow(
      /実在する日付/,
    );
  });

  it('since > until は拒否する', () => {
    expect(() => parseArgs(['--since', '2026-08-31', '--until', '2026-08-01'])).toThrow(
      /--since は --until 以前/,
    );
  });
});

const BOUNDS = {
  sinceMs: Date.parse('2026-08-01T00:00:00Z'),
  untilMs: Date.parse('2026-09-01T00:00:00Z'),
  cwdPrefix: '/repo',
};

type FixtureUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
};

function assistantRecord({
  id = 'msg_1',
  model = 'claude-sonnet-4-5',
  timestamp = '2026-08-15T00:00:00.000Z',
  cwd = '/repo',
  isSidechain = false,
  usage = {
    input_tokens: 1,
    output_tokens: 100,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5,
  } as FixtureUsage,
  content = [] as unknown[],
} = {}) {
  return { type: 'assistant', timestamp, cwd, isSidechain, message: { id, model, usage, content } };
}

function userTextRecord(text = 'こんにちは') {
  return { type: 'user', message: { role: 'user', content: text } };
}

function toolResultRecord(
  entries: unknown[],
  { timestamp = '2026-08-15T00:00:00.000Z', cwd = '/repo' } = {},
) {
  return { type: 'user', timestamp, cwd, message: { role: 'user', content: entries } };
}

describe('foldUsageRecord', () => {
  it('窓内 assistant レコードを model 別に集計する', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(agg, assistantRecord(), BOUNDS, ctx);
    const bucket = agg.models.get('sonnet');
    expect(bucket).toMatchObject({
      requests: 1,
      output: 100,
      input: 1,
      cacheRead: 10,
      cacheCreation: 5,
    });
  });

  it('message.id で dedup する（同一 id の 2 回目は無視）', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(agg, assistantRecord({ id: 'dup' }), BOUNDS, ctx);
    foldUsageRecord(agg, assistantRecord({ id: 'dup' }), BOUNDS, ctx);
    expect(agg.models.get('sonnet').requests).toBe(1);
  });

  it('窓外のタイムスタンプは無視する', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(agg, assistantRecord({ timestamp: '2026-07-31T23:59:59.000Z' }), BOUNDS, ctx);
    expect(agg.models.size).toBe(0);
  });

  it('cwd prefix が一致しないレコードは無視する', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(agg, assistantRecord({ cwd: '/other-repo' }), BOUNDS, ctx);
    expect(agg.models.size).toBe(0);
  });

  it('窓外・cwd 不一致の assistant record は表 B（tool_result サイズ）/ D（Bash prefix・chain）から除く', () => {
    const agg = createAggregate();

    // 窓外: 2026-07-31 は BOUNDS（2026-08-01〜2026-09-01）の外。
    const outOfWindowCtx = { file: 'out-of-window.jsonl', currentChain: null };
    foldUsageRecord(
      agg,
      assistantRecord({
        timestamp: '2026-07-31T23:59:59.000Z',
        content: [{ type: 'tool_use', id: 'tu_ow', name: 'Bash', input: { command: 'pnpm oow' } }],
      }),
      BOUNDS,
      outOfWindowCtx,
    );
    foldUsageRecord(
      agg,
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'tu_ow', content: 'out of window' }], {
        timestamp: '2026-07-31T23:59:59.000Z',
        cwd: '/repo',
      }),
      BOUNDS,
      outOfWindowCtx,
    );

    // cwd 不一致: BOUNDS は cwdPrefix '/repo'。
    const outOfCwdCtx = { file: 'out-of-cwd.jsonl', currentChain: null };
    foldUsageRecord(
      agg,
      assistantRecord({
        cwd: '/other-repo',
        content: [{ type: 'tool_use', id: 'tu_oc', name: 'Bash', input: { command: 'pnpm ooc' } }],
      }),
      BOUNDS,
      outOfCwdCtx,
    );
    foldUsageRecord(
      agg,
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'tu_oc', content: 'out of cwd' }], {
        cwd: '/other-repo',
      }),
      BOUNDS,
      outOfCwdCtx,
    );

    // どちらも B（tool_result サイズ）へ計上されない（'unknown' へも紛れ込まない）。
    expect(agg.toolResultSizes.size).toBe(0);
    // D（Bash prefix・chain）へも計上されない。
    expect(agg.bashPrefixes.size).toBe(0);
    expect(agg.chains).toHaveLength(0);
  });

  it('isSidechain === true は subagent 分として output を別枠計上する', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(agg, assistantRecord({ isSidechain: true }), BOUNDS, ctx);
    const bucket = agg.models.get('sonnet');
    expect(bucket.sidechainRequests).toBe(1);
    expect(bucket.sidechainOutput).toBe(100);
  });

  it('cache_creation.ephemeral_1h/5m_input_tokens を model 別に積む', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(
      agg,
      assistantRecord({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_1h_input_tokens: 70, ephemeral_5m_input_tokens: 30 },
        },
      }),
      BOUNDS,
      ctx,
    );
    const bucket = agg.models.get('sonnet');
    expect(bucket.ttl1h).toBe(70);
    expect(bucket.ttl5m).toBe(30);
  });

  it('thinking / text block の文字数と thinking block 数を model 別に積む', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(
      agg,
      assistantRecord({
        content: [
          { type: 'thinking', thinking: '12345' },
          { type: 'text', text: 'abc' },
          { type: 'redacted_thinking', data: 'opaque' },
        ],
      }),
      BOUNDS,
      ctx,
    );
    const bucket = agg.models.get('sonnet');
    expect(bucket.thinkingChars).toBe(5);
    expect(bucket.textChars).toBe(3);
    expect(bucket.thinkingBlocks).toBe(2);
  });
});

describe('collectToolResultSizes', () => {
  it('tool_use_id 経由で tool_result の chars を tool 名へ帰属する', () => {
    const records = [
      assistantRecord({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
      }),
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'hello world' }]),
    ];
    const sizes = collectToolResultSizes(records);
    expect(sizes.get('Read')).toEqual({ calls: 1, chars: 11, max: 11 });
  });

  it('配列 content（text block）の chars も数える', () => {
    const records = [
      assistantRecord({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: {} }],
      }),
      toolResultRecord([
        { type: 'tool_result', tool_use_id: 'tu_2', content: [{ type: 'text', text: 'abcd' }] },
      ]),
    ];
    const sizes = collectToolResultSizes(records);
    expect(sizes.get('Bash')).toEqual({ calls: 1, chars: 4, max: 4 });
  });

  it('対応する tool_use が見つからない tool_result は unknown へ帰属する', () => {
    const records = [
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'missing', content: 'xy' }]),
    ];
    const sizes = collectToolResultSizes(records);
    expect(sizes.get('unknown')).toEqual({ calls: 1, chars: 2, max: 2 });
  });

  it('max は複数 call のうち最大の chars を保持する（平均に埋もれる外れ値の可視化）', () => {
    const records = [
      assistantRecord({
        content: [{ type: 'tool_use', id: 'tu_3', name: 'Read', input: {} }],
      }),
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'tu_3', content: 'ab' }]),
      assistantRecord({
        content: [{ type: 'tool_use', id: 'tu_4', name: 'Read', input: {} }],
      }),
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'tu_4', content: 'a'.repeat(50) }]),
      assistantRecord({
        content: [{ type: 'tool_use', id: 'tu_5', name: 'Read', input: {} }],
      }),
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'tu_5', content: 'abc' }]),
    ];
    const sizes = collectToolResultSizes(records);
    expect(sizes.get('Read')).toEqual({ calls: 3, chars: 55, max: 50 });
  });
});

describe('collectL0Candidates', () => {
  it('Bash prefix を頻度集計する', () => {
    const records = {
      'a.jsonl': [
        assistantRecord({
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }],
        }),
        assistantRecord({
          content: [
            { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm test --watch' } },
          ],
        }),
      ],
    };
    const { bashPrefixes } = collectL0Candidates(records);
    expect(bashPrefixes.get('pnpm test')).toBe(2);
  });

  it('ユーザーの平文発話で連鎖が途切れる', () => {
    const records = {
      'a.jsonl': [
        assistantRecord({ content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
        assistantRecord({ content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] }),
        userTextRecord('ありがとう'),
        assistantRecord({ content: [{ type: 'tool_use', id: 't3', name: 'Read', input: {} }] }),
      ],
    };
    const { chains } = collectL0Candidates(records);
    const lengths = chains.map((c) => c.length).sort((a, b) => a - b);
    expect(lengths).toEqual([1, 2]);
  });

  it('tool_result（ユーザーの平文でない）は連鎖を途切れさせない', () => {
    const records = {
      'a.jsonl': [
        assistantRecord({ content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
        toolResultRecord([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
        assistantRecord({ content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] }),
      ],
    };
    const { chains } = collectL0Candidates(records);
    expect(chains).toHaveLength(1);
    expect(chains[0].length).toBe(2);
    expect(chains[0].tools.get('Bash')).toBe(1);
    expect(chains[0].tools.get('Read')).toBe(1);
  });
});

describe('human', () => {
  it('k/M/B 表記へ丸める', () => {
    expect(human(500)).toBe('500');
    expect(human(1500)).toBe('1.5k');
    expect(human(2_500_000)).toBe('2.50M');
    expect(human(3_200_000_000)).toBe('3.20B');
  });
});

describe('fetchMergedPrStats', () => {
  it('gh pr list を merged 検索で呼び revert を title proxy で数える', () => {
    const execFileImpl = vi.fn((_cmd: string, args: string[]) => {
      expect(args).toContain('merged');
      expect(args.some((a) => a.startsWith('merged:2026-08-01..2026-08-31'))).toBe(true);
      return JSON.stringify([
        { number: 1, title: '通常 PR' },
        { number: 2, title: 'Revert "壊れた変更"' },
      ]);
    });
    const stats = fetchMergedPrStats({ since: '2026-08-01', until: '2026-08-31', execFileImpl });
    expect(stats).toEqual({ merged: 2, reverts: 1 });
  });
});

describe('renderMarkdown', () => {
  it('固定 fixture で markdown ブロック全体を assert する', () => {
    const agg = createAggregate();
    const ctx = { file: 'session12345678.jsonl', currentChain: null };
    foldUsageRecord(
      agg,
      assistantRecord({
        content: [{ type: 'tool_use', id: 'tu_a', name: 'Bash', input: { command: 'pnpm test' } }],
      }),
      BOUNDS,
      ctx,
    );
    foldUsageRecord(
      agg,
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'tu_a', content: 'ok' }]),
      BOUNDS,
      ctx,
    );

    const markdown = renderMarkdown({
      since: '2026-08-01',
      until: '2026-08-31',
      agg,
      prStats: { merged: 2, reverts: 0 },
    });

    expect(markdown).toContain('### AI 経済メトリクス（2026-08-01〜2026-08-31）');
    expect(markdown).toContain('Claude Code の local transcript のみ');
    expect(markdown).toContain('Codex / Antigravity は未収集（不明であり 0 ではない）');
    expect(markdown).toContain('| sonnet | 1 | 100 |');
    expect(markdown).toContain('**merged PR 数**: 2');
    expect(markdown).toContain('**revert PR 数（title proxy）**: 0');
    expect(markdown).toContain('PR outcome は repo 全体');
    expect(markdown).not.toContain('output tok / merged PR');
    expect(markdown).toContain('| pnpm test | 1 |');
    expect(markdown).toContain('| Bash | 1 |');
    expect(markdown).toContain('session1 | 1 | Bash×1 |');
  });

  it('gh 失敗（prStats=null）は未取得と明記する', () => {
    const agg = createAggregate();
    const markdown = renderMarkdown({
      since: '2026-08-01',
      until: '2026-08-31',
      agg,
      prStats: null,
    });
    expect(markdown).toContain('**merged PR 数**: 未取得（gh 呼び出し失敗）');
  });

  it('セル内の | は escape する', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(
      agg,
      assistantRecord({
        content: [{ type: 'tool_use', id: 'tu_b', name: 'weird|name', input: {} }],
      }),
      BOUNDS,
      ctx,
    );
    foldUsageRecord(
      agg,
      toolResultRecord([{ type: 'tool_result', tool_use_id: 'tu_b', content: 'x' }]),
      BOUNDS,
      ctx,
    );
    const markdown = renderMarkdown({
      since: '2026-08-01',
      until: '2026-08-31',
      agg,
      prStats: null,
    });
    expect(markdown).toContain('weird\\|name');
  });

  it('表 F: thinking chars / text chars / thinking 比を描画する', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };
    foldUsageRecord(
      agg,
      assistantRecord({
        content: [
          { type: 'thinking', thinking: '1234567890' },
          { type: 'text', text: 'abcdefghij' },
        ],
      }),
      BOUNDS,
      ctx,
    );
    const markdown = renderMarkdown({
      since: '2026-08-01',
      until: '2026-08-31',
      agg,
      prStats: null,
    });
    expect(markdown).toContain('| model | thinking chars | text chars | thinking 比 |');
    expect(markdown).toContain('| sonnet | 10 | 10 | 50.0% |');
    expect(markdown).toContain(
      '**thinking の割合（全 model）**: 50.0%。effort を変えた効果はここに出る（routing skill 原則②）',
    );
  });

  it('表 F: thinking / text がゼロなら未取得', () => {
    const agg = createAggregate();
    const markdown = renderMarkdown({
      since: '2026-08-01',
      until: '2026-08-31',
      agg,
      prStats: null,
    });
    expect(markdown).toContain('| 未取得 | — | — | — |');
    expect(markdown).toContain(
      '**thinking の割合（全 model）**: 未取得。effort を変えた効果はここに出る（routing skill 原則②）',
    );
  });
});

describe('isSubagentFilePath', () => {
  it('subagents/agent-<id>.jsonl を検出する', () => {
    expect(
      isSubagentFilePath(
        '/Users/x/.claude/projects/-Users-x-dayopt/sess/subagents/agent-abc123.jsonl',
      ),
    ).toBe(true);
  });

  it('通常の session jsonl は対象外', () => {
    expect(isSubagentFilePath('/Users/x/.claude/projects/-Users-x-dayopt/sess.jsonl')).toBe(false);
  });
});

describe('computeExplorationBeforeEdit', () => {
  it('EDIT の前に出た EXPLORE を数える', () => {
    const records = [
      assistantRecord({ content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't4', name: 'Edit', input: {} }] }),
    ];
    expect(computeExplorationBeforeEdit(records)).toMatchObject({
      exploreCount: 3,
      hasEdit: true,
    });
  });

  it('EDIT が無ければ hasEdit: false（研究専任）', () => {
    const records = [
      assistantRecord({ content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }] }),
    ];
    expect(computeExplorationBeforeEdit(records)).toMatchObject({
      exploreCount: 2,
      hasEdit: false,
    });
  });

  it('最初の tool_use が EDIT なら探索 turn は 0', () => {
    const records = [
      assistantRecord({ content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] }),
    ];
    expect(computeExplorationBeforeEdit(records)).toMatchObject({
      exploreCount: 0,
      hasEdit: true,
    });
  });

  it('model は file 内で最も頻度の高い message.model（生ラベル）', () => {
    const records = [
      assistantRecord({ model: 'claude-sonnet-4-5', content: [] }),
      assistantRecord({ model: 'claude-sonnet-4-5', content: [] }),
      assistantRecord({ model: 'claude-fable-5', content: [] }),
    ];
    expect(computeExplorationBeforeEdit(records).model).toBe('claude-sonnet-4-5');
  });

  it('EDIT を含まないレコード・空配列は安全に処理する', () => {
    expect(computeExplorationBeforeEdit([])).toMatchObject({
      model: null,
      exploreCount: 0,
      hasEdit: false,
    });
    expect(computeExplorationBeforeEdit([{ type: 'user', message: {} }])).toMatchObject({
      exploreCount: 0,
      hasEdit: false,
    });
  });
});

describe('aggregateExplorationBeforeEdit', () => {
  it('model 別に編集ありの探索 turn 数配列・編集なし件数を畳む', () => {
    const byModel = aggregateExplorationBeforeEdit([
      { model: 'sonnet', exploreCount: 3, hasEdit: true },
      { model: 'sonnet', exploreCount: 5, hasEdit: true },
      { model: 'sonnet', exploreCount: 0, hasEdit: false },
      { model: 'haiku', exploreCount: 1, hasEdit: true },
    ]);
    expect(byModel.get('sonnet')).toEqual({ editValues: [3, 5], noEditN: 1 });
    expect(byModel.get('haiku')).toEqual({ editValues: [1], noEditN: 0 });
  });

  it('model が無いエントリは「不明」へ畳む', () => {
    const byModel = aggregateExplorationBeforeEdit([
      { model: null, exploreCount: 2, hasEdit: true },
    ]);
    expect(byModel.get('不明')).toEqual({ editValues: [2], noEditN: 0 });
  });

  it('空配列は空 Map', () => {
    expect(aggregateExplorationBeforeEdit([]).size).toBe(0);
  });
});

describe('computeMainSessionStats', () => {
  it('編集あり session は editCount / exploreCount / hasEdit を数える', () => {
    const records = [
      assistantRecord({ content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't4', name: 'Write', input: {} }] }),
    ];
    expect(computeMainSessionStats(records)).toMatchObject({
      exploreCount: 2,
      hasEdit: true,
      editCount: 2,
      agentCalls: 0,
      toolCalls: 4,
    });
  });

  it('Agent / Workflow の tool_use を agentCalls として数える', () => {
    const records = [
      assistantRecord({ content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't2', name: 'Workflow', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't3', name: 'Read', input: {} }] }),
    ];
    expect(computeMainSessionStats(records)).toMatchObject({
      agentCalls: 2,
      toolCalls: 3,
      editCount: 0,
      hasEdit: false,
    });
  });

  it('編集なし session は hasEdit: false・editCount: 0（研究/委譲専任）', () => {
    const records = [
      assistantRecord({ content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }] }),
      assistantRecord({ content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] }),
    ];
    expect(computeMainSessionStats(records)).toMatchObject({
      hasEdit: false,
      editCount: 0,
      agentCalls: 1,
      toolCalls: 2,
    });
  });

  it('空配列は安全に処理する', () => {
    expect(computeMainSessionStats([])).toMatchObject({
      model: null,
      exploreCount: 0,
      hasEdit: false,
      editCount: 0,
      agentCalls: 0,
      toolCalls: 0,
    });
  });
});

describe('aggregateMainSessions', () => {
  it('model 別に session n・編集あり session の Edit 数配列・探索 turn 配列・Agent 呼び出し合計を畳む', () => {
    const byModel = aggregateMainSessions([
      { model: 'sonnet', exploreCount: 2, hasEdit: true, editCount: 3, agentCalls: 1 },
      { model: 'sonnet', exploreCount: 4, hasEdit: true, editCount: 5, agentCalls: 0 },
      { model: 'sonnet', exploreCount: 0, hasEdit: false, editCount: 0, agentCalls: 2 },
      { model: 'opus', exploreCount: 1, hasEdit: true, editCount: 1, agentCalls: 0 },
    ]);
    expect(byModel.get('sonnet')).toEqual({
      n: 3,
      editN: 2,
      editCounts: [3, 5],
      exploreValues: [2, 4],
      agentCallsTotal: 3,
    });
    expect(byModel.get('opus')).toEqual({
      n: 1,
      editN: 1,
      editCounts: [1],
      exploreValues: [1],
      agentCallsTotal: 0,
    });
  });

  it('model が無いエントリは「不明」へ畳む', () => {
    const byModel = aggregateMainSessions([
      { model: null, exploreCount: 1, hasEdit: true, editCount: 1, agentCalls: 0 },
    ]);
    expect(byModel.get('不明')).toEqual({
      n: 1,
      editN: 1,
      editCounts: [1],
      exploreValues: [1],
      agentCallsTotal: 0,
    });
  });

  it('空配列は空 Map', () => {
    expect(aggregateMainSessions([]).size).toBe(0);
  });
});

describe('renderMarkdown（Claude Code top-level session 表）', () => {
  it('top-level session 表と割合行を描画する', () => {
    const agg = createAggregate();
    agg.mainSessions.push(
      {
        model: 'sonnet',
        exploreCount: 2,
        hasEdit: true,
        editCount: 4,
        agentCalls: 1,
        toolCalls: 7,
      },
      {
        model: 'sonnet',
        exploreCount: 0,
        hasEdit: false,
        editCount: 0,
        agentCalls: 3,
        toolCalls: 3,
      },
      { model: 'fable', exploreCount: 1, hasEdit: true, editCount: 2, agentCalls: 0, toolCalls: 3 },
    );

    const markdown = renderMarkdown({
      since: '2026-08-01',
      until: '2026-08-31',
      agg,
      prStats: null,
    });

    expect(markdown).toContain('**Claude Code top-level session**');
    expect(markdown).toContain(
      '| model | session n | 編集あり n | Edit 合計 | Edit 中央値 | 探索 turn 中央値 | Agent 呼び出し |',
    );
    expect(markdown).toContain('| sonnet | 2 | 1 | 4 | 4.0 | 2.0 | 4 |');
    expect(markdown).toContain('| fable | 1 | 1 | 2 | 2.0 | 1.0 | 0 |');
    expect(markdown).toContain('**Claude Code top-level session の編集あり割合**: 67%');
    expect(markdown).toContain('sonnet 50%');
    expect(markdown).toContain('fable 100%');
    expect(markdown).toContain('provider 間の品質・効率比較には使わない');
  });

  it('Main session が 0 件なら未取得を明記する', () => {
    const agg = createAggregate();
    const markdown = renderMarkdown({
      since: '2026-08-01',
      until: '2026-08-31',
      agg,
      prStats: null,
    });
    expect(markdown).toContain('| 未取得 | — | — | — | — | — | — |');
    expect(markdown).toContain('**Claude Code top-level session の編集あり割合**: 未取得');
  });
});

describe('subagent と Main session の分類は排他（isSubagentFilePath が単一の判定源）', () => {
  it('subagents/agent-*.jsonl は Main session ではない', () => {
    const file = '/Users/x/.claude/projects/-Users-x-dayopt/sess/subagents/agent-abc.jsonl';
    expect(isSubagentFilePath(file)).toBe(true);
  });

  it('top-level session jsonl は subagent ではない（= Main session 扱い）', () => {
    const file = '/Users/x/.claude/projects/-Users-x-dayopt/sess.jsonl';
    expect(isSubagentFilePath(file)).toBe(false);
  });
});

describe('getRepoRoot（#2674: worktree から実行しても main checkout を集計対象にする）', () => {
  const MAIN = '/repo';
  const LANE = '/repo/.claude/worktrees/lane';

  /** 実在しない fixture path をそのまま返す realpath（symlink 解決なし）。 */
  const identityRealpath = ((p: string) => p) as unknown as typeof import('node:fs').realpathSync;

  function makeGit(responses: Record<string, string>) {
    return vi.fn((_cmd: string, args: string[]) => {
      const key = args.join(' ');
      if (!(key in responses)) throw new Error(`unexpected git call: ${key}`);
      return responses[key];
    });
  }

  it('worktree から呼んでも main checkout の root を返す（旧実装は worktree 自身を返していた）', () => {
    const execFileImpl = makeGit({
      'rev-parse --show-toplevel': LANE,
      'rev-parse --absolute-git-dir': `${MAIN}/.git/worktrees/lane`,
      'rev-parse --git-common-dir': `${MAIN}/.git`,
      'worktree list --porcelain': `worktree ${MAIN}\n\nworktree ${LANE}\n`,
    });

    const root = getRepoRoot({
      execFileImpl: execFileImpl as never,
      cwd: LANE,
      realpathImpl: identityRealpath,
    });

    expect(root).toBe(MAIN);
    expect(root).not.toBe(LANE);
  });

  it('main checkout から呼んだ時も同じ root を返す（worktree 実行と結果が一致する）', () => {
    const responses = {
      'rev-parse --show-toplevel': MAIN,
      'rev-parse --absolute-git-dir': `${MAIN}/.git`,
      'rev-parse --git-common-dir': `${MAIN}/.git`,
      'worktree list --porcelain': `worktree ${MAIN}\n\nworktree ${LANE}\n`,
    };

    expect(
      getRepoRoot({
        execFileImpl: makeGit(responses) as never,
        cwd: MAIN,
        realpathImpl: identityRealpath,
      }),
    ).toBe(MAIN);
  });

  it('git が使えない時は cwd へ縮退する（従来どおり例外にしない）', () => {
    const execFileImpl = vi.fn(() => {
      throw new Error('git not found');
    });

    expect(
      getRepoRoot({
        execFileImpl: execFileImpl as never,
        cwd: '/tmp/x',
        realpathImpl: identityRealpath,
      }),
    ).toBe('/tmp/x');
  });

  it('main root を prefix にすると worktree 配下のセッションも集計に入る（#2674 手順 3）', () => {
    const agg = createAggregate();
    const ctx = { file: 'a.jsonl', currentChain: null };

    // BOUNDS.cwdPrefix は '/repo'（= main checkout root）。
    foldUsageRecord(agg, assistantRecord({ cwd: '/repo/.claude/worktrees/lane' }), BOUNDS, ctx);

    expect(agg.models.size).toBe(1);
  });
});
