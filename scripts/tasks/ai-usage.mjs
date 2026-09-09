import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { REPO, runGhJson } from '../lib/gh.mjs';
import { resolveMainCheckoutRoot } from '../lib/git-roots.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

/**
 * `pnpm ai:usage` — AI 経済メトリクス（Uber Software Factory 原則⑤「評価は
 * Token でなく Outcome」の Dayopt 写像、Sub-1。plan: dayopt-https-www-uber-com-
 * us-en-blog-ef-eventual-hare.md §Sub-1）。
 *
 * Claude Code の local transcript `~/.claude/projects/**\/*.jsonl` だけを 1 パスで
 * walk し、指定期間（既定は前月の
 * 暦月。gardening 手順 0 が前月分を見るため）について以下を集計する:
 *
 *   A. 消費 — model 別 requests / output / input / cache_read / cache_creation、
 *      output 構成比、subagent 比（isSidechain）、cache TTL（1h/5m）内訳、
 *      cache miss 比
 *   B. context bloat proxy — tool_use → tool_result の chars を tool 名へ帰属
 *   C. repo 成果（gh 経由）— 当該期間の merged PR 数・revert PR 数（title proxy）
 *   D. L0 候補検出 — Bash コマンドの先頭トークン頻度、および連続 tool_use
 *      チェイン（ユーザーの平文発話に遮られない連鎖）の上位
 *
 * **`scripts/hooks/session-token-usage.py` とはあえて共有しない。** あちらは
 * SessionStart 時に全 project 横断で直近 7 日 / 5 時間を見る「今すぐ委譲すべきか」
 * ビュー、こちらは 1 repo に絞った月次の「経済として健全か」ビュー。record 形状
 * （dedup は message.id、model ラベルは haiku/sonnet/opus/fable/mythos の部分一致、
 * mtime 窓での事前除外）は同じだが、`scripts/hooks/**` はクロスレビュー必須の
 * 保護対象 path であり、taxonomy test（scripts-taxonomy.test.ts）は package.json
 * エントリを持つ script を `scripts/tasks/` に置くことを要求する。共有 lib 化は
 * せず、知識だけこのヘッダへ複製する。drift が実害化したら共有化ではなく hook を
 * 削る方向で解く（月次ビューは週次ビューの上位集合）。
 *
 * 例外は git worktree 家系の解決だけで、`scripts/lib/git-roots.mjs` を使う（#2674）。
 * pre-tool-guard も同じ解決を必要とするが、あちらは「node 標準ライブラリしか
 * import しない」不変条件があるため自前の実装を持ち続ける。共有ではなく複製 +
 * contract test（scripts/lib/git-roots.test.ts）で drift を検出する。
 *
 * deferred（次回以降）: 円 / ドル換算（per-token 価格がローカルに無い）、
 * push 回数・review round・MTTR（PR ごと timeline API が N 回必要）、
 * Codex P1 件数、F1、`effort` / `attributionSkill` 別内訳、16 アンチパターンの
 * 自動 flag（数値だけ出し判定は人間パートへ）、Human intervention 回数の自動計測
 * （AskUserQuestion 件数を jsonl から数える案。今回は未計測）。
 */

export const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
export const SESSION_TELEMETRY_COVERAGE = Object.freeze({
  source: 'claude-code-local-jsonl',
  providers: Object.freeze({ claudeCode: 'collected', codex: null, antigravity: null }),
  missingMeans: 'unknown-not-zero',
});
const MODEL_LABELS = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'];
const BASH_PREFIX_LEADERS = new Set(['pnpm', 'npx', 'gh', 'git']);

// E. 着手までの探索 turn 数（subagent transcript、routing skill 目標状態との距離）。
const EXPLORE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'Agent',
]);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`。
const SUBAGENT_FILE_RE = /[/\\]subagents[/\\]agent-[^/\\]+\.jsonl$/;

/** model 名を短いラベルへ畳む。集計対象外（`<synthetic>` 等）なら null。 */
export function normalizeModelLabel(raw) {
  if (!raw) return null;
  const name = String(raw).toLowerCase();
  if (name.startsWith('<')) return null;
  for (const label of MODEL_LABELS) {
    if (name.includes(label)) return label;
  }
  return String(raw).slice(0, 24);
}

/** ファイル path が subagent transcript（`.../subagents/agent-<id>.jsonl`）かどうか。 */
export function isSubagentFilePath(filePath) {
  return SUBAGENT_FILE_RE.test(String(filePath ?? ''));
}

/**
 * 1 つの subagent transcript（file 内の record を file 順に並べた配列）から、
 * 最初の EDIT tool_use より前に出た EXPLORE tool_use の数を数える。EDIT が
 * 1 つも無ければ `hasEdit: false`（研究専任、中央値/平均の対象外）。
 * model は file 内で最も頻度の高い `message.model`（生ラベル、正規化は呼び出し側）。
 */
export function computeExplorationBeforeEdit(records) {
  const modelCounts = new Map();
  let exploreCount = 0;
  let hasEdit = false;
  let editFound = false;

  for (const record of records ?? []) {
    if (!record || record.type !== 'assistant') continue;
    const message = record.message ?? {};
    if (message.model) {
      modelCounts.set(message.model, (modelCounts.get(message.model) ?? 0) + 1);
    }
    if (editFound) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      if (EDIT_TOOLS.has(block.name)) {
        editFound = true;
        hasEdit = true;
        break;
      }
      if (EXPLORE_TOOLS.has(block.name)) exploreCount += 1;
    }
  }

  let model = null;
  let bestCount = 0;
  for (const [label, count] of modelCounts) {
    if (count > bestCount) {
      model = label;
      bestCount = count;
    }
  }

  return { model, exploreCount, hasEdit };
}

/**
 * Main session（`<session-id>.jsonl`、subagent 配下でない top-level transcript）
 * 1 ファイル分の record 列から、E 節「Main session」用の統計を 1 件作る。
 * `editCount`（EDIT tool_use 数）・`agentCalls`（`Agent`/`Workflow` tool_use 数）・
 * `toolCalls`（tool_use 総数）に加え、`computeExplorationBeforeEdit` を再利用した
 * `model` / `exploreCount` / `hasEdit` を持つ。Main が自分で実装しているか
 * （principle ① Frontier を既定にしない）を見るための計測。
 */
export function computeMainSessionStats(records) {
  const exploration = computeExplorationBeforeEdit(records);
  let editCount = 0;
  let agentCalls = 0;
  let toolCalls = 0;

  for (const record of records ?? []) {
    if (!record || record.type !== 'assistant') continue;
    const message = record.message ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      toolCalls += 1;
      if (EDIT_TOOLS.has(block.name)) editCount += 1;
      if (block.name === 'Agent' || block.name === 'Workflow') agentCalls += 1;
    }
  }

  return {
    model: exploration.model,
    exploreCount: exploration.exploreCount,
    hasEdit: exploration.hasEdit,
    editCount,
    agentCalls,
    toolCalls,
  };
}

/**
 * `computeMainSessionStats` の結果配列（model は既に `normalizeModelLabel` 済み）
 * を model 別へ畳む。`aggregateExplorationBeforeEdit` と対になる Main session 版。
 * Edit 合計・Edit 中央値・探索 turn 中央値は「編集あり session」だけを対象にする
 * （編集ゼロの session を混ぜると中央値が意味を失うため、既存 E 節と同じ扱い）。
 */
export function aggregateMainSessions(entries) {
  const byModel = new Map(); // label -> { n, editN, editCounts: number[], exploreValues: number[], agentCallsTotal }
  for (const entry of entries ?? []) {
    const label = entry.model ?? '不明';
    let bucket = byModel.get(label);
    if (!bucket) {
      bucket = { n: 0, editN: 0, editCounts: [], exploreValues: [], agentCallsTotal: 0 };
      byModel.set(label, bucket);
    }
    bucket.n += 1;
    bucket.agentCallsTotal += entry.agentCalls ?? 0;
    if (entry.hasEdit) {
      bucket.editN += 1;
      bucket.editCounts.push(entry.editCount ?? 0);
      bucket.exploreValues.push(entry.exploreCount ?? 0);
    }
  }
  return byModel;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * `computeExplorationBeforeEdit` の結果配列（model は既に `normalizeModelLabel` 済み）
 * を model 別へ畳む。編集ありの探索 turn 数配列と、編集なしの件数を持つ。
 */
export function aggregateExplorationBeforeEdit(entries) {
  const byModel = new Map(); // label -> { editValues: number[], noEditN: number }
  for (const entry of entries ?? []) {
    const label = entry.model ?? '不明';
    let bucket = byModel.get(label);
    if (!bucket) {
      bucket = { editValues: [], noEditN: 0 };
      byModel.set(label, bucket);
    }
    if (entry.hasEdit) bucket.editValues.push(entry.exploreCount);
    else bucket.noEditN += 1;
  }
  return byModel;
}

/** `YYYY-MM-DD` 文字列から UTC 深夜の Date を作る。`endOfDay` なら翌日 00:00（inclusive 終端）。 */
function parseDateBoundary(value, endOfDay) {
  const [y, m, d] = value.split('-').map((n) => Number(n));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * `YYYY-MM-DD` が実在するカレンダー日付かどうか。`Date.UTC` は範囲外の日
 * （例: 2026-02-31）を自動繰り上げ（2026-03-03）するため、正規表現での書式
 * チェックだけでは非実在日付を素通ししてしまう。年月日を作った `Date` を
 * 逆変換して一致するかで判定する。
 * @param {string} value
 */
function isValidCalendarDateStr(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function toDateStr(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** 既定窓 = 前月の暦月（JST/UTC のズレは許容。月次の粒度で十分）。 */
export function defaultWindow(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11、前月は m-1
  const start = new Date(Date.UTC(y, m - 1, 1));
  const endExclusive = new Date(Date.UTC(y, m, 1)); // 今月 1 日 00:00 = 前月末の翌日
  return { since: toDateStr(start), until: toDateStr(new Date(endExclusive.getTime() - 86400000)) };
}

/** CLI 引数を解釈する。未知の引数は例外。 */
export function parseArgs(argv, now = new Date()) {
  const options = { ...defaultWindow(now), json: false, cwdPrefix: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since') {
      options.since = argv[i + 1];
      i += 1;
    } else if (arg === '--until') {
      options.until = argv[i + 1];
      i += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--cwd-prefix') {
      options.cwdPrefix = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`未知の引数です: ${arg}（--since / --until / --json / --cwd-prefix のみ）`);
    }
  }
  if (!isValidCalendarDateStr(options.since)) {
    throw new Error(`--since は実在する日付を YYYY-MM-DD で指定する: "${options.since}"`);
  }
  if (!isValidCalendarDateStr(options.until)) {
    throw new Error(`--until は実在する日付を YYYY-MM-DD で指定する: "${options.until}"`);
  }
  if (options.since > options.until) {
    throw new Error(`--since は --until 以前にしてください: ${options.since} > ${options.until}`);
  }
  return options;
}

/**
 * @typedef {{ file: string, length: number, tools: Map<string, number> }} Chain
 */

/** 新しい集計器を作る。 */
export function createAggregate() {
  return {
    seenMessageIds: new Set(),
    models: new Map(), // label -> { requests, output, input, cacheRead, cacheCreation, sidechainRequests, sidechainOutput, ttl1h, ttl5m }
    toolNamesById: new Map(), // tool_use_id -> tool name（帰属できない tool_result は無視）
    toolResultSizes: new Map(), // tool name -> { calls, chars, max }
    bashPrefixes: new Map(), // prefix -> calls
    /** @type {Chain[]} */
    chains: [],
    // { model, exploreCount, hasEdit }[]（subagent transcript 1 ファイル = 1 要素）。
    explorationAgents: [],
    // Main session = top-level `<session-id>.jsonl` 1 ファイル = 1 要素。
    /** @type {{ model: string|null, exploreCount: number, hasEdit: boolean, editCount: number, agentCalls: number, toolCalls: number }[]} */
    mainSessions: [],
  };
}

function ensureModelBucket(models, label) {
  let bucket = models.get(label);
  if (!bucket) {
    bucket = {
      requests: 0,
      output: 0,
      input: 0,
      cacheRead: 0,
      cacheCreation: 0,
      sidechainRequests: 0,
      sidechainOutput: 0,
      ttl1h: 0,
      ttl5m: 0,
      thinkingChars: 0,
      textChars: 0,
      thinkingBlocks: 0,
    };
    models.set(label, bucket);
  }
  return bucket;
}

/**
 * Bash `input.command` から先頭の cd セグメントを 1 回だけ剥がし、続く
 * コメント行・空行も読み飛ばして prefix トークンを返す。
 *
 * 剥がす形（実測の 2026-08 データで判明した既知パターン）:
 * - `cd <path> && <command>` / `cd <path>; <command>`
 * - `cd <path>\n<command>`（改行区切り。`&&` より出現頻度が高い）
 * - `cd "<quoted path>" && …`（`cd "$(git rev-parse --show-toplevel)" && …`
 *   のようにパス自体に空白を含む形。ダブル/シングルクォートの中身は空白可）
 *
 * コマンド全体が `cd <path>` だけ（後続コマンドが無い）の場合は L0 候補として
 * 意味を持たないため null を返す（カウントしない）。
 */
export function extractBashPrefix(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  const CD_PATH = '(?:"[^"]*"|\'[^\']*\'|\\S+)';
  if (new RegExp(`^cd\\s+${CD_PATH}\\s*$`).test(trimmed)) return null;

  let cmd = trimmed;
  const cdMatch = cmd.match(new RegExp(`^cd\\s+${CD_PATH}\\s*(?:&&|;|\\n)\\s*`));
  if (cdMatch) cmd = cmd.slice(cdMatch[0].length);

  // 先頭のコメント行（`# …`）・空行を読み飛ばす。
  const lines = cmd.split('\n');
  while (lines.length > 0) {
    const line = lines[0].trim();
    if (line === '' || line.startsWith('#')) {
      lines.shift();
      continue;
    }
    break;
  }
  cmd = lines.join('\n').trim();
  if (!cmd) return null;

  const tokens = cmd.split(/\s+/);
  const first = tokens[0];
  if (BASH_PREFIX_LEADERS.has(first) && tokens.length > 1) {
    return `${first} ${tokens[1]}`;
  }
  return first;
}

/**
 * tool_result の content から文字数を数える。string / `{type:'text',text}[]` の
 * どちらの形も受ける。
 */
function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        return sum + block.text.length;
      }
      return sum;
    }, 0);
  }
  return 0;
}

/**
 * timestamp が bounds の窓内かどうか。`sinceMs`/`untilMs` がどちらも無限大
 * （`collectToolResultSizes` 等、test 用の窓なし呼び出し）の時は「窓の指定が無い」
 * とみなし、record 自身に timestamp が無くても通す。実運用（`scanProjects` 経由）
 * では常に有限の `sinceMs`/`untilMs` が渡るため、この分岐は無窓呼び出し専用。
 * @param {number} timestampMs
 * @param {{ sinceMs: number, untilMs: number }} bounds
 */
function isTimestampInWindow(timestampMs, bounds) {
  const hasWindow = Number.isFinite(bounds.sinceMs) || Number.isFinite(bounds.untilMs);
  if (!hasWindow) return true;
  return (
    Number.isFinite(timestampMs) && timestampMs >= bounds.sinceMs && timestampMs < bounds.untilMs
  );
}

/**
 * 1 レコード（parse 済み JSON）を集計へ畳み込む。窓外・cwd 不一致・dedup 済みは
 * 無視する。isDirectExecution 系の副作用は持たず純関数として test できる。
 * @param {ReturnType<typeof createAggregate>} agg
 * @param {unknown} record
 * @param {{ sinceMs: number, untilMs: number, cwdPrefix: string }} bounds
 * @param {{ file: string }} ctx チェイン検出用に file 名を渡す
 */
export function foldUsageRecord(agg, record, bounds, ctx) {
  if (!record || typeof record !== 'object') return;

  if (record.type === 'assistant') {
    const message = record.message ?? {};
    const usage = message.usage ?? {};
    const messageId = message.id;
    const timestamp = record.timestamp ? Date.parse(record.timestamp) : NaN;
    const cwd = typeof record.cwd === 'string' ? record.cwd : '';

    const inWindow = isTimestampInWindow(timestamp, bounds);
    const cwdMatches = !bounds.cwdPrefix || cwd.startsWith(bounds.cwdPrefix);
    // 窓外・cwd 不一致の record は B（context bloat）/D（L0 候補）のどちらにも
    // 混ぜない。tool_use → 名前の Map は tool_result 側の帰属に使うため、ここで
    // 対象外にした id は後段の tool_result（type: 'user'）でも 'unknown' 扱いに
    // なり、選択した期間・repo 以外の record が表へ紛れ込まない。
    const accepted = inWindow && cwdMatches;

    const content = Array.isArray(message.content) ? message.content : [];
    if (accepted) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') {
          agg.toolNamesById.set(block.id, block.name ?? 'unknown');
          if (block.name === 'Bash' && block.input && typeof block.input.command === 'string') {
            const prefix = extractBashPrefix(block.input.command);
            if (prefix) {
              agg.bashPrefixes.set(prefix, (agg.bashPrefixes.get(prefix) ?? 0) + 1);
            }
          }
        }
      }
    }

    if (accepted && messageId && !agg.seenMessageIds.has(messageId)) {
      agg.seenMessageIds.add(messageId);
      const label = normalizeModelLabel(message.model);
      if (label) {
        const bucket = ensureModelBucket(agg.models, label);
        bucket.requests += 1;
        bucket.output += usage.output_tokens ?? 0;
        bucket.input += usage.input_tokens ?? 0;
        bucket.cacheRead += usage.cache_read_input_tokens ?? 0;
        bucket.cacheCreation += usage.cache_creation_input_tokens ?? 0;
        bucket.ttl1h += usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        bucket.ttl5m += usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'thinking') {
            bucket.thinkingChars += typeof block.thinking === 'string' ? block.thinking.length : 0;
            bucket.thinkingBlocks += 1;
          } else if (block.type === 'redacted_thinking') {
            bucket.thinkingBlocks += 1;
          } else if (block.type === 'text') {
            bucket.textChars += typeof block.text === 'string' ? block.text.length : 0;
          }
        }
        if (record.isSidechain === true) {
          bucket.sidechainRequests += 1;
          bucket.sidechainOutput += usage.output_tokens ?? 0;
        }
      }
    }

    // チェイン検出: このレコードに tool_use が含まれれば「進行中チェイン」を継続。
    // 窓外・cwd 不一致の record は D（L0 候補）のチェイン長へ混ぜない。
    if (accepted) {
      const toolUseBlocks = content.filter((b) => b && b.type === 'tool_use');
      if (toolUseBlocks.length > 0) {
        let chain = ctx.currentChain;
        if (!chain || chain.file !== ctx.file) {
          chain = { file: ctx.file, length: 0, tools: new Map() };
          ctx.currentChain = chain;
          agg.chains.push(chain);
        }
        chain.length += toolUseBlocks.length;
        for (const block of toolUseBlocks) {
          const name = block.name ?? 'unknown';
          chain.tools.set(name, (chain.tools.get(name) ?? 0) + 1);
        }
      }
    }
    return;
  }

  if (record.type === 'user') {
    const message = record.message ?? {};
    const content = message.content;
    const timestamp = record.timestamp ? Date.parse(record.timestamp) : NaN;
    const cwd = typeof record.cwd === 'string' ? record.cwd : '';
    const inWindow = isTimestampInWindow(timestamp, bounds);
    const cwdMatches = !bounds.cwdPrefix || cwd.startsWith(bounds.cwdPrefix);
    // tool_result 自身は timestamp を持たないことが多いが、user record（親）は
    // 持つ。B（context bloat）を選択した期間・repo に絞るためここでも同じ判定を
    // 適用する。tool_result に紐づく tool_use が窓外だった場合も toolNamesById
    // には登録されていないため 'unknown' 帰属になるが、この record 自体の
    // 窓外判定で二重に弾く（tool_use が in-window でも tool_result の親 record が
    // 窓外なら B には数えない）。
    const accepted = inWindow && cwdMatches;
    if (typeof content === 'string') {
      // 平文発話 = チェインを断ち切る。
      ctx.currentChain = null;
      return;
    }
    if (Array.isArray(content)) {
      let hasToolResult = false;
      for (const block of content) {
        if (block && block.type === 'tool_result') {
          hasToolResult = true;
          if (accepted) {
            const name = agg.toolNamesById.get(block.tool_use_id) ?? 'unknown';
            const chars = contentLength(block.content);
            let sizeBucket = agg.toolResultSizes.get(name);
            if (!sizeBucket) {
              sizeBucket = { calls: 0, chars: 0, max: 0 };
              agg.toolResultSizes.set(name, sizeBucket);
            }
            sizeBucket.calls += 1;
            sizeBucket.chars += chars;
            if (chars > sizeBucket.max) sizeBucket.max = chars;
          }
        } else if (block && block.type === 'text') {
          hasToolResult = false;
        }
      }
      if (!hasToolResult) {
        // plain text ブロックのみ（tool_result を含まない）= 発話としてチェインを断ち切る。
        ctx.currentChain = null;
      }
    }
  }
}

/** tool_result のサイズ集計だけを独立して呼びたい test 用の薄いラッパー。 */
export function collectToolResultSizes(
  records,
  bounds = { sinceMs: -Infinity, untilMs: Infinity, cwdPrefix: '' },
) {
  const agg = createAggregate();
  const ctx = { file: 'test', currentChain: null };
  for (const record of records) {
    foldUsageRecord(agg, record, bounds, ctx);
  }
  return agg.toolResultSizes;
}

/** L0 候補検出（Bash prefix 頻度 + チェイン）だけを独立して呼びたい test 用ラッパー。 */
export function collectL0Candidates(
  recordsByFile,
  bounds = { sinceMs: -Infinity, untilMs: Infinity, cwdPrefix: '' },
) {
  const agg = createAggregate();
  for (const [file, records] of Object.entries(recordsByFile)) {
    const ctx = { file, currentChain: null };
    for (const record of records) {
      foldUsageRecord(agg, record, bounds, ctx);
    }
  }
  return { bashPrefixes: agg.bashPrefixes, chains: agg.chains };
}

function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** k/M/B 表記へ丸める（`scripts/hooks/session-token-usage.py` の `human()` と同じ閾値）。 */
export function human(value) {
  const v = Number(value) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function pct(value, total) {
  if (!total) return '—';
  return `${((value * 100) / total).toFixed(1)}%`;
}

/** markdown table cell の `|` を escape する（`scripts/lib/markdown-table.ts` は .ts のため .mjs から import 不可。複製せずインラインする）。 */
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

/** repo root 配下の `.jsonl` を列挙する。`~/.claude/projects` が無ければ空配列。 */
export function listJsonlFiles(projectsDir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true, recursive: true });
  } catch {
    return null; // 不在
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const dir = entry.parentPath ?? entry.path ?? projectsDir;
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

// cwd が無い subagent record 向けの fallback: project ディレクトリ名は cwd の
// `/`（`\` も一応）をすべて `-` に置換した形（例: `/Users/x/dayopt` →
// `-Users-x-dayopt`）。実測（2026-08）の `~/.claude/projects/<dir>/` と一致。
export function cwdPrefixToProjectDirSegment(cwdPrefix) {
  return String(cwdPrefix ?? '').replace(/[/\\]/g, '-');
}

/**
 * ファイル最初の timestamp が時間窓内か、かつ cwd が一致するかを判定する。時間窓は
 * ファイルの最初の timestamp、cwd はレコードにあればそれを見て `cwdPrefix` と
 * 突合し、無ければファイル path が project ディレクトリ名を含むかで代用する。
 * subagent transcript・Main session 双方の E 節エントリ生成で共有する。
 */
function fileMatchesWindowAndCwd(fileRecords, file, { sinceMs, untilMs, cwdPrefix }) {
  const firstTimestamp = fileRecords.find((r) => typeof r?.timestamp === 'string')?.timestamp;
  const firstTsMs = firstTimestamp ? Date.parse(firstTimestamp) : NaN;
  if (!Number.isFinite(firstTsMs) || firstTsMs < sinceMs || firstTsMs >= untilMs) return false;

  const cwdRecord = fileRecords.find((r) => typeof r?.cwd === 'string');
  return cwdRecord
    ? !cwdPrefix || cwdRecord.cwd.startsWith(cwdPrefix)
    : !cwdPrefix || file.includes(cwdPrefixToProjectDirSegment(cwdPrefix));
}

/**
 * subagent transcript 1 ファイル分の record 列から、E 節（着手までの探索 turn 数）
 * 用のエントリを 1 件作る。窓外 / cwd 不一致なら null。
 */
function buildExplorationEntry(fileRecords, file, bounds) {
  if (!fileMatchesWindowAndCwd(fileRecords, file, bounds)) return null;

  const result = computeExplorationBeforeEdit(fileRecords);
  return {
    model: normalizeModelLabel(result.model),
    exploreCount: result.exploreCount,
    hasEdit: result.hasEdit,
  };
}

/**
 * Main session（top-level `<session-id>.jsonl`）1 ファイル分の record 列から、
 * E 節「Main session」用のエントリを 1 件作る。窓外 / cwd 不一致なら null。
 */
function buildMainSessionEntry(fileRecords, file, bounds) {
  if (!fileMatchesWindowAndCwd(fileRecords, file, bounds)) return null;

  const stats = computeMainSessionStats(fileRecords);
  return {
    model: normalizeModelLabel(stats.model),
    exploreCount: stats.exploreCount,
    hasEdit: stats.hasEdit,
    editCount: stats.editCount,
    agentCalls: stats.agentCalls,
    toolCalls: stats.toolCalls,
  };
}

/** jsonl 全ファイルを walk して集計する（副作用: FS 読み込み）。 */
export function scanProjects({ projectsDir = PROJECTS_DIR, sinceMs, untilMs, cwdPrefix }) {
  const files = listJsonlFiles(projectsDir);
  if (files === null) return null;

  const agg = createAggregate();
  // mtime が since の 1 日前より古いファイルは窓外なのでスキップする。
  const mtimeCutoffMs = sinceMs - 86400000;

  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < mtimeCutoffMs) continue;

    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const isSubagent = isSubagentFilePath(file);
    // subagent transcript は E 節（探索 turn 数）、top-level session は Main
    // session 統計（E 節「Main session」）用に同じパスで record 列を溜める。
    // 2 回目の読み込みはしない（1 パス方針）。
    const fileRecords = [];
    const ctx = { file, currentChain: null };
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      fileRecords.push(record);
      foldUsageRecord(agg, record, { sinceMs, untilMs, cwdPrefix }, ctx);
    }
    if (fileRecords.length > 0) {
      if (isSubagent) {
        const entry = buildExplorationEntry(fileRecords, file, { sinceMs, untilMs, cwdPrefix });
        if (entry) agg.explorationAgents.push(entry);
      } else {
        const entry = buildMainSessionEntry(fileRecords, file, { sinceMs, untilMs, cwdPrefix });
        if (entry) agg.mainSessions.push(entry);
      }
    }
  }
  return agg;
}

/** gh から当該期間の merged / revert PR 数を取る。失敗したら null（呼び出し側が「未取得」に倒す）。 */
export function fetchMergedPrStats({ since, until, execFileImpl } = {}) {
  const prs = runGhJson(
    [
      'pr',
      'list',
      '--repo',
      REPO,
      '--state',
      'merged',
      '--search',
      `merged:${since}..${until}`,
      '--limit',
      '500',
      '--json',
      'number,title',
    ],
    { execFileImpl },
  );
  const merged = prs.length;
  const reverts = prs.filter((pr) => /revert/i.test(pr.title ?? '')).length;
  return { merged, reverts };
}

/** A〜D + gh 成果を markdown へ描画する。fixture ベースの test で形を固定する。 */
export function renderMarkdown({ since, until, agg, prStats }) {
  const lines = [];
  lines.push(`### AI 経済メトリクス（${since}〜${until}）`);
  lines.push('');
  lines.push(
    '**session telemetry**: Claude Code の local transcript のみ。Codex / Antigravity は未収集（不明であり 0 ではない）。',
  );
  lines.push('');

  // 表 A: model 別消費
  const totalOutput = [...agg.models.values()].reduce((s, b) => s + b.output, 0);
  lines.push(
    '| model | requests | output | input | cache_read | cache_creation | output 構成比 | subagent 比 | cache 1h/5m 比 |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const modelRows = [...agg.models.entries()].sort((a, b) => b[1].output - a[1].output);
  for (const [label, bucket] of modelRows) {
    const subagentSharePct = pct(bucket.sidechainOutput, bucket.output);
    const ttlTotal = bucket.ttl1h + bucket.ttl5m;
    const ttlShare = ttlTotal
      ? `${((bucket.ttl1h * 100) / ttlTotal).toFixed(0)}%/${((bucket.ttl5m * 100) / ttlTotal).toFixed(0)}%`
      : '—';
    lines.push(
      `| ${escapeCell(label)} | ${bucket.requests} | ${human(bucket.output)} | ${human(bucket.input)} | ${human(bucket.cacheRead)} | ${human(bucket.cacheCreation)} | ${pct(bucket.output, totalOutput)} | ${subagentSharePct} | ${ttlShare} |`,
    );
  }
  if (modelRows.length === 0) {
    lines.push('| 未取得 | — | — | — | — | — | — | — | — |');
  }

  const totalCacheRead = [...agg.models.values()].reduce((s, b) => s + b.cacheRead, 0);
  const totalCacheCreation = [...agg.models.values()].reduce((s, b) => s + b.cacheCreation, 0);
  const missDenominator = totalCacheRead + totalCacheCreation;
  lines.push('');
  lines.push(
    `**cache miss 比（全 model 合算）**: ${
      missDenominator ? `${((totalCacheCreation * 100) / missDenominator).toFixed(1)}%` : '未取得'
    }`,
  );
  lines.push('');

  // 表 B: tool_result サイズ
  lines.push('| tool | calls | total chars | avg | max | 構成比 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  const totalChars = [...agg.toolResultSizes.values()].reduce((s, v) => s + v.chars, 0);
  const toolRows = [...agg.toolResultSizes.entries()]
    .sort((a, b) => b[1].chars - a[1].chars)
    .slice(0, 8);
  for (const [name, sizeBucket] of toolRows) {
    const avg = sizeBucket.calls ? Math.round(sizeBucket.chars / sizeBucket.calls) : 0;
    lines.push(
      `| ${escapeCell(name)} | ${sizeBucket.calls} | ${human(sizeBucket.chars)} | ${human(avg)} | ${human(sizeBucket.max)} | ${pct(sizeBucket.chars, totalChars)} |`,
    );
  }
  if (toolRows.length === 0) {
    lines.push('| 未取得 | — | — | — | — | — |');
  }
  lines.push('');

  // 表 C: repo 全体の成果（gh）。Claude Code session telemetry へ帰属させない。
  if (prStats) {
    lines.push(`**merged PR 数**: ${prStats.merged}`);
    lines.push(`**revert PR 数（title proxy）**: ${prStats.reverts}`);
  } else {
    lines.push('**merged PR 数**: 未取得（gh 呼び出し失敗）');
    lines.push('**revert PR 数（title proxy）**: 未取得');
  }
  lines.push(
    '**帰属境界**: PR outcome は repo 全体。provider attribution が無いため Claude Code の token / session と割って効率指標にしない。',
  );
  lines.push('');

  // 表 D1: Bash prefix
  lines.push('| Bash prefix | calls |');
  lines.push('| --- | --- |');
  const prefixRows = topEntries(agg.bashPrefixes, 10);
  for (const [prefix, calls] of prefixRows) {
    lines.push(`| ${escapeCell(prefix)} | ${calls} |`);
  }
  if (prefixRows.length === 0) {
    lines.push('| 未取得 | — |');
  }
  lines.push('');

  // 表 D2: チェイン
  lines.push('| session | chain length | dominant tools |');
  lines.push('| --- | --- | --- |');
  const chainRows = [...agg.chains]
    .filter((c) => c.length > 0)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
  for (const chain of chainRows) {
    const dominant = topEntries(chain.tools, 3)
      .map(([name, count]) => `${name}×${count}`)
      .join(', ');
    const sessionLabel =
      chain.file
        .split('/')
        .pop()
        ?.replace(/\.jsonl$/, '')
        .slice(0, 8) ?? chain.file.slice(0, 8);
    lines.push(`| ${escapeCell(sessionLabel)} | ${chain.length} | ${escapeCell(dominant)} |`);
  }
  if (chainRows.length === 0) {
    lines.push('| 未取得 | — | — |');
  }
  lines.push('');

  // 表 E: 着手までの探索 turn 数（subagent、routing skill 目標状態との距離）
  lines.push('| model | 編集あり n | 探索 turn 中央値 | 平均 | 最大 | 編集なし n |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  const explorationByModel = aggregateExplorationBeforeEdit(agg.explorationAgents);
  const explorationRows = [...explorationByModel.entries()].sort(
    (a, b) => b[1].editValues.length - a[1].editValues.length,
  );
  for (const [label, bucket] of explorationRows) {
    const med = median(bucket.editValues);
    const avg = mean(bucket.editValues);
    const max = bucket.editValues.length ? Math.max(...bucket.editValues) : null;
    lines.push(
      `| ${escapeCell(label)} | ${bucket.editValues.length} | ${med === null ? '—' : med.toFixed(1)} | ${avg === null ? '—' : avg.toFixed(1)} | ${max === null ? '—' : max} | ${bucket.noEditN} |`,
    );
  }
  if (explorationRows.length === 0) {
    lines.push('| 未取得 | — | — | — | — | — |');
  }
  lines.push('');

  const allEditValues = [...explorationByModel.values()].flatMap((b) => b.editValues);
  const overallMedian = median(allEditValues);
  const overallMean = mean(allEditValues);
  lines.push(
    `**着手までの探索 turn（subagent）**: ${
      allEditValues.length === 0
        ? '未取得'
        : `全体 中央値 ${overallMedian.toFixed(1)} / 平均 ${overallMean.toFixed(1)}（n=${allEditValues.length}）`
    }。目標はゼロに近いこと（routing skill 目標状態）`,
  );
  const heavyNoEdit = ['opus', 'fable'].reduce(
    (sum, label) => sum + (explorationByModel.get(label)?.noEditN ?? 0),
    0,
  );
  lines.push(
    `**Claude Code の編集なし Opus + Fable subagent**: ${heavyNoEdit} 件（用途は transcript から個別確認）`,
  );

  // 表 E の続き: Main session（Main 自身が実装しているか、principle ① との距離）
  lines.push('');
  lines.push('**Claude Code top-level session**');
  lines.push('');
  lines.push(
    '| model | session n | 編集あり n | Edit 合計 | Edit 中央値 | 探索 turn 中央値 | Agent 呼び出し |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  const mainSessionByModel = aggregateMainSessions(agg.mainSessions);
  const mainSessionRows = [...mainSessionByModel.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [label, bucket] of mainSessionRows) {
    const editTotal = bucket.editCounts.reduce((s, v) => s + v, 0);
    const editMedian = median(bucket.editCounts);
    const exploreMedian = median(bucket.exploreValues);
    lines.push(
      `| ${escapeCell(label)} | ${bucket.n} | ${bucket.editN} | ${editTotal} | ${editMedian === null ? '—' : editMedian.toFixed(1)} | ${exploreMedian === null ? '—' : exploreMedian.toFixed(1)} | ${bucket.agentCallsTotal} |`,
    );
  }
  if (mainSessionRows.length === 0) {
    lines.push('| 未取得 | — | — | — | — | — | — |');
  }
  lines.push('');

  const totalMainN = mainSessionRows.reduce((s, [, bucket]) => s + bucket.n, 0);
  const totalMainEditN = mainSessionRows.reduce((s, [, bucket]) => s + bucket.editN, 0);
  const overallMainPct = totalMainN === 0 ? null : (totalMainEditN / totalMainN) * 100;
  const perModelPct = ['opus', 'fable', 'sonnet']
    .map((label) => {
      const bucket = mainSessionByModel.get(label);
      const pct = bucket && bucket.n > 0 ? (bucket.editN / bucket.n) * 100 : null;
      return `${label} ${pct === null ? '—' : `${pct.toFixed(0)}%`}`;
    })
    .join(' / ');
  lines.push(
    `**Claude Code top-level session の編集あり割合**: ${overallMainPct === null ? '未取得' : `${overallMainPct.toFixed(0)}%`}（編集あり session ÷ session n、model 別: ${perModelPct}）。provider 間の品質・効率比較には使わない`,
  );

  // 表 F: thinking の量（effort を変えた効果、routing skill 原則②）
  lines.push('');
  lines.push('| model | thinking chars | text chars | thinking 比 |');
  lines.push('| --- | --- | --- | --- |');
  const thinkingRows = [...agg.models.entries()].sort(
    (a, b) => b[1].thinkingChars - a[1].thinkingChars,
  );
  let totalThinkingChars = 0;
  let totalTextChars = 0;
  for (const [label, bucket] of thinkingRows) {
    totalThinkingChars += bucket.thinkingChars;
    totalTextChars += bucket.textChars;
    const denom = bucket.thinkingChars + bucket.textChars;
    const ratio = denom ? `${((bucket.thinkingChars * 100) / denom).toFixed(1)}%` : '—';
    lines.push(
      `| ${escapeCell(label)} | ${human(bucket.thinkingChars)} | ${human(bucket.textChars)} | ${ratio} |`,
    );
  }
  if (thinkingRows.length === 0) {
    lines.push('| 未取得 | — | — | — |');
  }
  lines.push('');
  const overallThinkingDenom = totalThinkingChars + totalTextChars;
  lines.push(
    `**thinking の割合（全 model）**: ${
      overallThinkingDenom === 0
        ? '未取得'
        : `${((totalThinkingChars * 100) / overallThinkingDenom).toFixed(1)}%`
    }。effort を変えた効果はここに出る（routing skill 原則②）`,
  );

  return lines.join('\n');
}

function buildAggregateObject({ since, until, projectsDir, cwdPrefix }) {
  const sinceMs = parseDateBoundary(since, false).getTime();
  const untilMs = parseDateBoundary(until, true).getTime();
  const agg = scanProjects({ projectsDir, sinceMs, untilMs, cwdPrefix });
  return { sinceMs, untilMs, agg };
}

/**
 * 集計対象の cwd prefix に使う repo root を返す（#2674）。
 *
 * **`git rev-parse --show-toplevel` は使わない。** worktree から実行すると
 * `.claude/worktrees/<name>` が返り、`scanProjects` の prefix 一致が
 * 「この worktree 配下の cwd を持つセッション」だけになる。main checkout と
 * 兄弟 worktree のセッションは無音で除外され、月次の数値が黙って小さくなる
 * （#2596 の実測: worktree 実行だと 8 月分が全項目「未取得」、9 月の Opus output は
 * main checkout の 1/7）。
 *
 * 代わりに家系の main checkout root を返す。worktree は main checkout 配下の
 * `.claude/worktrees/*` に作る運用（AGENTS.md §PR / git 運用）なので、main root の
 * prefix 一致で家系全体が 1 つの repo として集計に入る。
 *
 * @param {{
 *   execFileImpl?: typeof execFileSync,
 *   cwd?: string,
 *   realpathImpl?: typeof import('node:fs').realpathSync,
 * }} [options] realpathImpl は test 用の注入点
 */
export function getRepoRoot({
  execFileImpl = execFileSync,
  cwd = process.cwd(),
  realpathImpl,
} = {}) {
  const mainRoot = resolveMainCheckoutRoot(cwd, execFileImpl, { realpathImpl });
  if (mainRoot) return mainRoot;
  // 家系を解けない時（git が無い / 非 git ディレクトリ）は従来どおりの縮退。
  try {
    return execFileImpl('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return cwd;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwdPrefix = options.cwdPrefix ?? getRepoRoot();
  const { sinceMs, untilMs, agg } = buildAggregateObject({
    since: options.since,
    until: options.until,
    projectsDir: PROJECTS_DIR,
    cwdPrefix,
  });

  let prStats = null;
  try {
    prStats = fetchMergedPrStats({ since: options.since, until: options.until });
  } catch {
    prStats = null;
  }

  if (agg === null) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ since: options.since, until: options.until, sessionTelemetryCoverage: SESSION_TELEMETRY_COVERAGE, error: 'projects_dir_missing', prStats }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `### AI 経済メトリクス（${options.since}〜${options.until}）\n\n**session telemetry**: Claude Code の local transcript のみ。Codex / Antigravity は未収集（不明であり 0 ではない）。\n\n未取得（~/.claude/projects が存在しない）\n`,
      );
    }
    return;
  }

  if (options.json) {
    const modelsObj = Object.fromEntries(agg.models);
    const toolResultSizesObj = Object.fromEntries(agg.toolResultSizes);
    const bashPrefixesObj = Object.fromEntries(agg.bashPrefixes);
    const explorationByModel = aggregateExplorationBeforeEdit(agg.explorationAgents);
    const explorationBeforeEdit = Object.fromEntries(
      [...explorationByModel.entries()].map(([label, bucket]) => [
        label,
        {
          editN: bucket.editValues.length,
          median: median(bucket.editValues),
          mean: mean(bucket.editValues),
          max: bucket.editValues.length ? Math.max(...bucket.editValues) : null,
          noEditN: bucket.noEditN,
        },
      ]),
    );
    const mainSessionByModel = aggregateMainSessions(agg.mainSessions);
    const mainSessions = Object.fromEntries(
      [...mainSessionByModel.entries()].map(([label, bucket]) => [
        label,
        {
          n: bucket.n,
          editN: bucket.editN,
          editTotal: bucket.editCounts.reduce((s, v) => s + v, 0),
          editMedian: median(bucket.editCounts),
          exploreMedian: median(bucket.exploreValues),
          agentCallsTotal: bucket.agentCallsTotal,
        },
      ]),
    );
    const thinking = Object.fromEntries(
      [...agg.models.entries()].map(([label, bucket]) => {
        const denom = bucket.thinkingChars + bucket.textChars;
        return [
          label,
          {
            thinkingChars: bucket.thinkingChars,
            textChars: bucket.textChars,
            thinkingBlocks: bucket.thinkingBlocks,
            ratio: denom ? bucket.thinkingChars / denom : null,
          },
        ];
      }),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          since: options.since,
          until: options.until,
          sessionTelemetryCoverage: SESSION_TELEMETRY_COVERAGE,
          models: modelsObj,
          toolResultSizes: toolResultSizesObj,
          bashPrefixes: bashPrefixesObj,
          chains: agg.chains
            .filter((c) => c.length > 0)
            .map((c) => ({ file: c.file, length: c.length, tools: Object.fromEntries(c.tools) })),
          explorationBeforeEdit,
          mainSessions,
          thinking,
          prStats,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `${renderMarkdown({ since: options.since, until: options.until, agg, prStats })}\n`,
  );
}

if (isDirectExecution(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'ai-usage failed');
    process.exitCode = 1;
  }
}
