import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO, runGh, runGhJson } from '../lib/gh.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { CLAUDE_REVIEW_MARKER } from '../lib/review-policy.mjs';
import {
  computeExplorationBeforeEdit,
  cwdPrefixToProjectDirSegment,
  human,
  isSubagentFilePath,
  listJsonlFiles,
  normalizeModelLabel,
  PROJECTS_DIR,
  SESSION_TELEMETRY_COVERAGE,
} from './ai-usage.mjs';
import { detectJudgmentRecords, extractLinkedIssueNumbers } from './ctx.mjs';

/**
 * `pnpm trace <PR> [--json]` — 「AI が何を見て、なぜその判断をし、何を実行し、
 * その判断が正しかったか」を PR 番号を軸に 1 コマンドで追跡する（routing skill
 * §目標状態、AGENTS.md 委任・報告の作法）。
 *
 * Storage は追加しない。material は Claude Code session log（`~/.claude/projects/**\/*.jsonl`）、
 * git、GitHub、`docs/decisions.md` の 4 つ。`ctx.mjs`（判断の記録の検出）と
 * `ai-usage.mjs`（jsonl walker・model 正規化・探索 turn 計算）をそのまま流用する。
 *
 * 出力は 120 行以内、判定そのものはしない（「判定は人が行う」と明記する箇所を除く）。
 * gh 呼び出しは各セクション独立に fail-closed（そのセクションだけ「未取得」）。
 *
 * deferred（次回以降）: timeline API の `committed` event が実際に返らない環境の
 * 網羅的な fallback 検証、Codex 以外のレビュー bot への拡張、session log の
 * cwd ベース突合（現状は project ディレクトリ名の完全一致のみ）。
 */

const [REPO_OWNER, REPO_NAME] = REPO.split('/');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// --- CLI 引数 ---------------------------------------------------------------

/** CLI 引数を解釈する。位置引数は PR 番号 1 つのみ。 */
export function parseArgs(argv) {
  const options = { number: null, json: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知の引数です: ${arg}（--json のみ）`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) {
    throw new Error('PR 番号を 1 つ指定してください: pnpm trace <N>');
  }
  const number = Number(positionals[0]);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`不正な番号です: ${positionals[0]}`);
  }
  options.number = number;
  return options;
}

function tryOr(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// --- Part 2 見た・実行（session） -------------------------------------------

/** jsonl テキストを 1 行 1 record へ parse する。壊れた行は無視する。 */
export function parseJsonlLines(raw) {
  const records = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 壊れた行は無視（1 行の破損で全体を落とさない）。
    }
  }
  return records;
}

/**
 * `<session-id>/subagents/agent-*.jsonl` の path から親 session id を取り出す。
 * subagents ディレクトリの直上セグメントが session id（実測ディレクトリ構造）。
 */
export function sessionIdFromSubagentPath(filePath) {
  const parts = String(filePath ?? '').split(/[/\\]/);
  const idx = parts.lastIndexOf('subagents');
  if (idx <= 0) return null;
  return parts[idx - 1];
}

/**
 * project ディレクトリ配下のファイル一覧を session 単位へ束ねる。
 * 戻り値は `Map<sessionId, { sessionFile: string|null, subagentFiles: string[] }>`。
 */
export function groupFilesBySession(files) {
  const map = new Map();
  const ensure = (sid) => {
    let entry = map.get(sid);
    if (!entry) {
      entry = { sessionFile: null, subagentFiles: [] };
      map.set(sid, entry);
    }
    return entry;
  };
  for (const file of files ?? []) {
    if (isSubagentFilePath(file)) {
      const sid = sessionIdFromSubagentPath(file);
      if (!sid) continue;
      ensure(sid).subagentFiles.push(file);
    } else {
      const base = String(file).split(/[/\\]/).pop() ?? file;
      const sid = base.replace(/\.jsonl$/, '');
      ensure(sid).sessionFile = file;
    }
  }
  return map;
}

/** session の record 列の中に `gitBranch === headRefName` の record が 1 つでもあるか。 */
export function matchesBranch(records, headRefName) {
  if (!headRefName) return false;
  return (records ?? []).some((r) => r && r.gitBranch === headRefName);
}

/** `projectsDir` 直下のディレクトリ名一覧（`listDirsImpl` の既定実装）。 */
function defaultListProjectDirNames(projectsDir) {
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * `headRefName` の project ディレクトリを walk し、branch が一致する session だけの
 * record 列を集める（I/O をここへ閉じ込め、以降の集計は純関数にする）。
 *
 * **worktree 対応**: worktree（`.claude/worktrees/<name>`）内で動いた session の
 * project ディレクトリ名は、リポジトリ本体の cwd（`cwdPrefix`）ではなく worktree の
 * cwd をエンコードした名前になる（例: `-Users-x-dayopt` の本体に対し worktree は
 * `-Users-x-dayopt-.claude-worktrees-foo`）。エンコードは `/` → `-` の単純置換で
 * サブディレクトリ関係を保つため、本体の project ディレクトリ名を **prefix** として
 * 持つ全ディレクトリを列挙し、それぞれで branch 一致 session を集める。
 * @param {{
 *   projectsDir?: string,
 *   cwdPrefix?: string,
 *   headRefName?: string,
 *   readFileImpl?: (path: string, encoding: string) => string,
 *   listFilesImpl?: (projectDir: string) => string[] | null,
 *   listDirsImpl?: (projectsDir: string) => string[],
 * }} [options]
 */
export function loadSessionEntriesForBranch({
  projectsDir = PROJECTS_DIR,
  cwdPrefix,
  headRefName,
  readFileImpl = readFileSync,
  listFilesImpl = listJsonlFiles,
  listDirsImpl = defaultListProjectDirNames,
} = {}) {
  const projectDirSegment = cwdPrefixToProjectDirSegment(cwdPrefix);
  const dirNames = tryOr(() => listDirsImpl(projectsDir), []) ?? [];
  // **prefix 一致では兄弟 repo を巻き込む**（`-dayopt` に対し `-dayopt-web` 等）。
  // 対象は「その repo 自身」と「その repo の worktree」だけなので、完全一致か
  // worktree の命名（`<segment>-.claude-worktrees-...`）に限る（#2560 項目 2）。
  const matchingDirNames = dirNames.filter(
    (name) =>
      name === projectDirSegment || name.startsWith(`${projectDirSegment}-.claude-worktrees-`),
  );

  const entries = [];
  let anyDirFound = false;
  for (const dirName of matchingDirNames) {
    const projectDir = join(projectsDir, dirName);
    const files = tryOr(() => listFilesImpl(projectDir), null);
    if (files === null) continue;
    anyDirFound = true;

    const groups = groupFilesBySession(files);
    for (const [sessionId, { sessionFile, subagentFiles }] of groups) {
      if (!sessionFile) continue;
      const raw = tryOr(() => readFileImpl(sessionFile, 'utf8'), null);
      if (raw === null) continue;
      // JSONL の全行 parse は重い（実測: 203 dir / 1,596 file / 1.2GB を全 parse）。
      // branch 名の生文字列が本文に無ければ `matchesBranch` は必ず false になるので、
      // parse する前に落とす（#2560 項目 2）。branch 名未指定時は従来どおり全件見る。
      if (headRefName && !raw.includes(`"gitBranch":"${headRefName}"`)) continue;
      const records = parseJsonlLines(raw);
      if (!matchesBranch(records, headRefName)) continue;
      entries.push({ sessionId, records, subagentCount: subagentFiles.length });
    }
  }
  return anyDirFound ? entries : null;
}

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 1 session（`records` は session file 由来、subagent 側は数のみ数える）の集計行を作る。
 * model 構成は output token 上位 2 個、探索 turn は `computeExplorationBeforeEdit`
 * （最初の Edit より前の探索 tool_use 数。Edit が無ければ null = 対象外）。
 */
export function buildSessionRow({ sessionId, records, subagentCount }) {
  const firstTimestamp = (records ?? []).find((r) => typeof r?.timestamp === 'string')?.timestamp;
  const startMs = firstTimestamp ? Date.parse(firstTimestamp) : null;

  const modelOutput = new Map();
  let toolCalls = 0;
  let editCalls = 0;
  for (const record of records ?? []) {
    if (!record || record.type !== 'assistant') continue;
    const message = record.message ?? {};
    const usage = message.usage ?? {};
    const label = normalizeModelLabel(message.model);
    if (label) {
      modelOutput.set(label, (modelOutput.get(label) ?? 0) + (usage.output_tokens ?? 0));
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      toolCalls += 1;
      if (EDIT_TOOLS.has(block.name)) editCalls += 1;
    }
  }

  const explore = computeExplorationBeforeEdit(records ?? []);
  const modelTop2 = [...modelOutput.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label, out]) => `${label}(${human(out)})`)
    .join(', ');

  return {
    sessionId,
    startMs,
    startLabel: startMs ? new Date(startMs).toISOString().slice(0, 16).replace('T', ' ') : '不明',
    modelSummary: modelTop2 || '不明',
    modelOutput,
    toolCalls,
    editCalls,
    exploreTurns: explore.hasEdit ? explore.exploreCount : null,
    subagentCount,
  };
}

/**
 * `loadSessionEntriesForBranch` の結果から表示用の行（最大 10、新しい順）と
 * summary（全 match session 対象、表示上限の影響を受けない）を組む。
 */
export function buildSessionSection(entries) {
  const rows = (entries ?? [])
    .map(buildSessionRow)
    .sort((a, b) => (b.startMs ?? -1) - (a.startMs ?? -1));
  const displayed = rows.slice(0, 10);

  const modelTotals = new Map();
  let totalEdit = 0;
  const exploreValues = [];
  for (const row of rows) {
    for (const [label, out] of row.modelOutput) {
      modelTotals.set(label, (modelTotals.get(label) ?? 0) + out);
    }
    totalEdit += row.editCalls;
    if (row.exploreTurns !== null) exploreValues.push(row.exploreTurns);
  }

  return {
    displayed,
    // 表示は最新 10 件に絞るが、`hasNoEditHeavyModelSession` のような所見判定は
    // 表示外の session も見落としてはいけない（#2530 push 前反証レビュー P2:
    // 11 件目以降に「編集なしの Opus/Fable」があっても displayed だけ見ると
    // 検出できない）。summary 計算と同じ全件（rows）をここに残す。
    all: rows,
    summary: {
      sessionCount: rows.length,
      modelTotals,
      totalEdit,
      exploreMedian: median(exploreValues),
    },
  };
}

/** editCalls===0 かつ model 構成に opus/fable を含む session が 1 つでもあるか（routing skill 反例）。 */
export function hasNoEditHeavyModelSession(rows) {
  return (rows ?? []).some(
    (row) => row.editCalls === 0 && /\b(opus|fable)\b/i.test(row.modelSummary ?? ''),
  );
}

// --- Part 3 判断 -------------------------------------------------------------

/** PR body に `## 検証` 見出しがあるか。 */
export function hasVerificationSection(body) {
  return /^##\s*検証\s*$/m.test(body ?? '');
}

/** DoD 本文の抜粋（先頭 3 行）を取る。DoD/完了の定義 の言及行から始める簡易抽出。 */
export function extractDodExcerpt(text) {
  const lines = String(text ?? '').split('\n');
  const idx = lines.findIndex((l) => /(DoD|完了の定義)/.test(l));
  if (idx === -1) return '';
  return lines.slice(idx, idx + 3).join('\n');
}

// --- Part 4 レビュー ---------------------------------------------------------

/**
 * レビュー bot の投稿か。2026-10 から Claude review（`claude-review.yml`）が担い、
 * 投稿者は `github-actions[bot]` で marker を必ず含む。それ以前の PR は Codex
 * （`chatgpt-codex-connector`）なので、過去の履歴を読むために両方を数える。
 * GraphQL の `author.login` と REST の `user.login` で `[bot]` の有無が割れるので
 * 正規化する。集計・表示専用で、merge を gate する用途では使わない。
 */
const CODEX_BOT_LOGIN = 'chatgpt-codex-connector';

function isReviewBotItem(item) {
  const login = String(item?.user?.login ?? '').replace(/\[bot\]$/, '');
  if (login === CODEX_BOT_LOGIN) return true;
  return login === 'github-actions' && String(item?.body ?? '').includes(CLAUDE_REVIEW_MARKER);
}

/** timeline event 配列から `ready_for_review` の日時（無ければ null）。 */
export function findReadyForReviewDate(timelineEvents) {
  const ev = (timelineEvents ?? []).find((e) => e?.event === 'ready_for_review');
  return ev?.created_at ?? null;
}

/** timeline の `committed` event を ready 日時以降だけ数える。readyDate が無ければ null。 */
export function countCommitsAfterReady(timelineEvents, readyDate) {
  if (!readyDate) return null;
  const readyMs = Date.parse(readyDate);
  return (timelineEvents ?? []).filter((e) => {
    if (e?.event !== 'committed') return false;
    const ts = Date.parse(e.committed_date ?? e.created_at ?? '');
    return Number.isFinite(ts) && ts > readyMs;
  }).length;
}

/** timeline に `committed` event が 1 つも無い（API が対応していない）かどうか。 */
export function timelineLacksCommitEvents(timelineEvents) {
  return !(timelineEvents ?? []).some((e) => e?.event === 'committed');
}

/** `gh pr view --json commits` の fallback で ready 日時以降の commit 数を数える。 */
export function countCommitsAfterReadyFallback(commits, readyDate) {
  if (!readyDate) return null;
  const readyMs = Date.parse(readyDate);
  return (commits ?? []).filter((c) => {
    const ts = Date.parse(c?.committedDate ?? '');
    return Number.isFinite(ts) && ts > readyMs;
  }).length;
}

/** レビュー bot（`reviews` + `pulls/N/comments`）の P1/P2 言及件数を数える。 */
export function countReviewPriorities(reviews, comments) {
  const items = [...(reviews ?? []), ...(comments ?? [])];
  let p1 = 0;
  let p2 = 0;
  for (const item of items) {
    // `[bot]` サフィックス一致だけで判定すると dependabot[bot] 等の無関係な bot
    // コメントに "P1" という文字列が含まれるだけで誤計上する（#2530）。
    if (!isReviewBotItem(item)) continue;
    const body = item?.body ?? '';
    if (/\bP1\b/.test(body)) p1 += 1;
    if (/\bP2\b/.test(body)) p2 += 1;
  }
  return { p1, p2 };
}

/** レビュー summary marker を含むコメントが有るか（pr-cross-review skill）。 */
export function hasInternalReviewMarker(comments) {
  return (comments ?? []).some(
    (c) =>
      typeof c?.body === 'string' &&
      REVIEW_SUMMARY_MARKERS.some((marker) => c.body.includes(marker)),
  );
}

/**
 * レビュー依頼（`@claude review`、過去分は `@codex review`）の投稿回数・bot の応答回数・
 * そのうち「問題なし」だった回数を数える（#2558 手順 6）。
 *
 * 無駄の構造は「レビューの有効性を HEAD で判定していた」ことにあり、その症状は
 * 「投げた回数のわりに指摘が出ない」という形で現れる（PR #2554 実測: 投稿 8 /
 * 応答 7 / 問題なし 6）。月次 gardening でこの 3 数字を読めるようにする。
 */
export function countReviewRequestCycles(comments) {
  let requests = 0;
  let responses = 0;
  let cleanResponses = 0;
  for (const comment of comments ?? []) {
    const body = comment?.body ?? '';
    if (isReviewBotItem(comment)) {
      responses += 1;
      // 指摘は badge markup か `P1: <非ゼロ>` / `Findings: <非ゼロ>` の形で出る。どれも無ければ
      // 「問題なし」とみなす（表示用の概算。gate の判定とは別物）。
      const claimsFindings =
        /!\[P[12] Badge\]/.test(body) ||
        /P[12][*_ \t]*[：:][*_ \t]*[1-9]/.test(body) ||
        /^Findings:\s*[1-9]/m.test(body);
      if (!claimsFindings) cleanResponses += 1;
      continue;
    }
    if (body.includes('@claude review') || body.includes('@codex review')) requests += 1;
  }
  return { requests, responses, cleanResponses };
}

// --- Part 4b 内製クロスレビュー（marker の role 別歩留まり） -----------------
//
// `[internal-review]` marker は 2026-09 以前は role 横断の集計（P1/P2 合計・
// agent 一覧・partial coverage 申告 role）しか持たなかった。`generate-marker-core.ts`
// の `deriveRoleFindingsField` が `--review-result` 経由の生成時に `findings:` 行
// （role 別の件数 + P1/P2 内訳、例: `risk-reviewer=2(P1 1/P2 1), behavior-verifier=0`）
// を書くようになったため、この行があれば authoritative な数値として最優先で読む
// （`parseMarkerFindingsField`）。行が無い古い marker、または `role(text-fallback)=不明`
// （StructuredOutput を経ていないため件数を信用できない）の role は、PR の review
// comment（inline, `pulls/{n}/comments`）と issue comment の本文に role 名が部分一致で
// 現れる件数をプロキシとして数える旧ヒューリスティックへ fall back する
// （`countRoleFindingsHeuristic`）。SKILL.md の投稿フォーマットは inline comment に
// role 名タグを必須にしていないため、こちらは下限の近似値であり過小計上しうる —
// 実際の指摘は 0 でなくても role 名を書かない comment だけなら 0 と出る。render・
// json 双方で `findingsSource`（`'marker' | 'estimate'`）としてどちらの経路かを明示する。

const KNOWN_REVIEWER_ROLES = ['risk-reviewer', 'behavior-verifier', 'architecture-guard'];

/**
 * OWNER/MEMBER/COLLABORATOR が投稿したレビュー summary コメントだけを抽出する。
 *
 * **gate はこのコメントを読まない**（#2562 で証跡は commit status へ移った）。
 * ここで読むのは role 別 findings 内訳という分析用の情報で、gate の判定材料では
 * ない。marker は新しい `[review-summary]` と、過去 PR に残る旧 `[internal-review]`
 * の両方を受け付ける（trace は過去の PR を遡って読むため）。
 */
const REVIEW_SUMMARY_MARKERS = ['[review-summary]', '[internal-review]'];

export function filterInternalReviewMarkerComments(issueComments) {
  const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
  return (issueComments ?? []).filter((c) => {
    if (typeof c?.body !== 'string') return false;
    if (!trustedAssociations.has(c?.author_association)) return false;
    const body = c.body.trimStart();
    return REVIEW_SUMMARY_MARKERS.some((marker) => body.startsWith(marker));
  });
}

/** marker 本文の `agent:` 行を `{role, status}[]` へ分解する（`role(text-fallback)` 注釈を認識）。 */
export function parseMarkerAgentField(body) {
  const match = /^agent:\s*(.+)$/m.exec(body ?? '');
  if (!match) return [];
  return match[1]
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const fallbackMatch = /^(.+?)\(text-fallback\)$/.exec(token);
      return fallbackMatch
        ? { role: fallbackMatch[1].trim(), status: 'text-fallback' }
        : { role: token, status: 'ok' };
    });
}

/** marker 本文の `partial coverage: role, role（note）` 行から partial 申告 role 名を抜く。 */
export function parseMarkerPartialCoverageRoles(body) {
  const match = /^partial coverage:\s*(.+)$/m.exec(body ?? '');
  if (!match) return [];
  const withoutNote = match[1].replace(/（.*$/, '').trim();
  return withoutNote
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

const REVIEW_RESULT_STATUSES = new Set(['not-run', 'stale', 'partial', 'reviewed', 'invalid']);

/** `status: role=reviewed, role=partial` を role -> status へ分解する。 */
export function parseMarkerStatusField(body) {
  const match = /^status:\s*(.+)$/m.exec(body ?? '');
  if (!match) return {};
  const result = {};
  for (const token of match[1].split(',').map((value) => value.trim())) {
    const eqIndex = token.indexOf('=');
    if (eqIndex === -1) continue;
    const role = token.slice(0, eqIndex).trim();
    const status = token.slice(eqIndex + 1).trim();
    if (KNOWN_REVIEWER_ROLES.includes(role)) {
      result[role] = REVIEW_RESULT_STATUSES.has(status) ? status : 'invalid';
    }
  }
  return result;
}

/** marker 本文の `head:` 行から 40 桁 hex の head SHA を取る（無ければ null）。 */
export function parseMarkerHeadSha(body) {
  const match = /^head:\s*([0-9a-f]{40})\s*$/m.exec(body ?? '');
  return match ? match[1] : null;
}

/**
 * marker 本文の `findings:` 行（`generate-marker-core.ts` の `deriveRoleFindingsField`
 * が書く書式、例: `findings: risk-reviewer=2(P1 1/P2 1), behavior-verifier=0,
 * architecture-guard(text-fallback)=不明`）を role ごとの件数へ分解する。
 *
 * 値が数値で始まらない role（`=不明` の text-fallback）は `null` にする —
 * 呼び出し側（`buildInternalReviewSection`）はこれをヒューリスティック fall back の
 * トリガーとして扱う。行自体が無ければ空オブジェクトを返す（古い marker との後方互換）。
 */
export function parseMarkerFindingsField(body) {
  const match = /^findings:\s*(.+)$/m.exec(body ?? '');
  if (!match) return {};
  const result = {};
  for (const token of match[1].split(',').map((t) => t.trim())) {
    if (!token) continue;
    const eqIndex = token.indexOf('=');
    if (eqIndex === -1) continue;
    const role = token
      .slice(0, eqIndex)
      .replace(/\(text-fallback\)$/, '')
      .trim();
    const valuePart = token.slice(eqIndex + 1).trim();
    if (!role) continue;
    const countMatch = /^(\d+)/.exec(valuePart);
    result[role] = countMatch ? Number(countMatch[1]) : null;
  }
  return result;
}

/** marker の `created_at` 以後の commit 数（`gh pr view --json commits` の commits 配列基準）。 */
export function countCommitsAfterMarker(commits, markerCreatedAt) {
  if (!markerCreatedAt) return null;
  const markerMs = Date.parse(markerCreatedAt);
  return (commits ?? []).filter((c) => {
    const ts = Date.parse(c?.committedDate ?? '');
    return Number.isFinite(ts) && ts > markerMs;
  }).length;
}

/**
 * role 名の部分一致で findings 件数を近似する（上記ヒューリスティック注記を参照）。
 * 大文字小文字は無視する。
 */
export function countRoleFindingsHeuristic(role, reviewComments, issueComments) {
  const needle = String(role).toLowerCase();
  const items = [...(reviewComments ?? []), ...(issueComments ?? [])];
  return items.filter(
    (item) => typeof item?.body === 'string' && item.body.toLowerCase().includes(needle),
  ).length;
}

/**
 * marker 群 + PR の review/issue comment・commits から内製クロスレビューの role 別
 * 歩留まりセクションを組み立てる。marker が 1 件も無ければ null（セクション自体を省く）。
 * 複数 marker がある場合（HEAD が動いて張り直された場合）は最新 marker の role 構成を
 * 使い、`markerCount` にだけ全 marker 数を残す。
 */
export function buildInternalReviewSection({
  issueComments,
  reviewComments,
  commits,
  headSha = /** @type {string | null} */ (null),
}) {
  const markers = filterInternalReviewMarkerComments(issueComments);
  if (markers.length === 0) return null;

  const sorted = [...markers].sort(
    (a, b) => Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0),
  );
  const latest = sorted[sorted.length - 1];

  const agentRoles = parseMarkerAgentField(latest.body);
  const partialRoles = new Set(parseMarkerPartialCoverageRoles(latest.body));
  const resultStatuses = parseMarkerStatusField(latest.body);
  const hasResultStatusLine = /^status:\s*(.+)$/m.test(latest.body ?? '');
  const markerFindings = parseMarkerFindingsField(latest.body);
  const commitsAfterMarker = countCommitsAfterMarker(commits, latest.created_at);
  const latestHeadSha = parseMarkerHeadSha(latest.body);

  // findings ヒューリスティックの対象から marker コメント自身を除く（`agent:` /
  // `partial coverage:` / `findings:` 行に role 名がそのまま載るため、含めると
  // 自己一致で過大計上する）。
  const markerCommentSet = new Set(markers);
  const nonMarkerIssueComments = (issueComments ?? []).filter((c) => !markerCommentSet.has(c));

  // ヒューリスティック推定は marker 単位で時間分割できない（review comment /
  // issue comment 自体が個々の marker に紐付いていないため）。role ごとに 1 回だけ
  // 計算し、findings: 行を持たない marker の raund すべてで同じ推定値を使う。
  const estimateByRole = new Map();
  const estimateFor = (role) => {
    if (!estimateByRole.has(role)) {
      estimateByRole.set(
        role,
        countRoleFindingsHeuristic(role, reviewComments, nonMarkerIssueComments),
      );
    }
    return estimateByRole.get(role);
  };

  const roles = agentRoles
    .filter((r) => KNOWN_REVIEWER_ROLES.includes(r.role))
    .map((r) => {
      const explicitStatus = hasResultStatusLine ? (resultStatuses[r.role] ?? 'invalid') : null;
      const markerHeadMismatch = headSha !== null && latestHeadSha !== headSha;
      const timestampShowsStale = headSha === null && commitsAfterMarker > 0;
      const status =
        markerHeadMismatch || timestampShowsStale ? 'stale' : (explicitStatus ?? r.status);
      const coverage = status === 'partial' || partialRoles.has(r.role) ? 'partial' : 'complete';
      const usableResult = (status === 'reviewed' || status === 'ok') && coverage === 'complete';
      const markerCount = Object.prototype.hasOwnProperty.call(markerFindings, r.role)
        ? markerFindings[r.role]
        : undefined;
      const hasAuthoritativeCount = typeof markerCount === 'number';
      const findings = usableResult
        ? hasAuthoritativeCount
          ? markerCount
          : hasResultStatusLine
            ? null
            : estimateFor(r.role)
        : null;
      const findingsSource = usableResult
        ? hasAuthoritativeCount
          ? 'marker'
          : hasResultStatusLine
            ? 'status'
            : 'estimate'
        : 'status';

      // 歩留まり判定（`computeZeroFindingRoleNotes`）は「最新 marker だけ 0 件」
      // では止まらない — round 1 で 2 件拾って round 2（re-review）で 0 件になった
      // だけの role を「指摘ゼロの role」と誤認し、scope 縮小 / 廃止候補に挙げて
      // しまう（#2530 push 前反証レビュー P2）。PR 上の全 marker を横断して合計し、
      // それを判定に使う。findings: 行が無い marker はここでも同じ推定値を加算する。
      // marker 由来の実数を足し合わせ、`findings:` 行を持たない marker（古い書式や
      // text-fallback）については**推定を 1 回だけ**足す。marker ごとに推定を
      // 加算すると、round を重ねた PR ほど同じ推定値が多重に積まれて役割別の
      // 歩留まりが実態と乖離する（#2560 項目 4）。
      let markerDerivedFindings = 0;
      let markersMissingField = 0;
      let hasUnconfirmedRound = false;
      for (const marker of sorted) {
        if (!parseMarkerAgentField(marker.body).some((entry) => entry.role === r.role)) continue;
        const perMarkerFindings = parseMarkerFindingsField(marker.body);
        const perMarkerCount = Object.prototype.hasOwnProperty.call(perMarkerFindings, r.role)
          ? perMarkerFindings[r.role]
          : undefined;
        const perMarkerHasStatus = /^status:\s*(.+)$/m.test(marker.body ?? '');
        if (perMarkerHasStatus) {
          const perMarkerStatus = parseMarkerStatusField(marker.body)[r.role] ?? 'invalid';
          if (perMarkerStatus !== 'reviewed' || typeof perMarkerCount !== 'number') {
            hasUnconfirmedRound = true;
            continue;
          }
        }
        if (typeof perMarkerCount === 'number') {
          markerDerivedFindings += perMarkerCount;
        } else {
          markersMissingField += 1;
        }
      }
      const totalFindings =
        usableResult && !hasUnconfirmedRound && findings !== null
          ? markerDerivedFindings + (markersMissingField > 0 ? estimateFor(r.role) : 0)
          : null;

      return {
        role: r.role,
        status,
        coverage,
        findings,
        findingsSource,
        totalFindings,
        // 推定が混ざったかを表示側が区別できるようにする（marker 由来の実数だけを
        // 見たい月次 gardening 用。#2560 項目 4）。
        totalFindingsEstimated: markersMissingField > 0,
        commitsAfterMarker,
      };
    });

  return {
    markerCount: markers.length,
    latestMarkerCreatedAt: latest.created_at ?? null,
    latestHeadSha,
    roles,
  };
}

/** 指摘 0 件の role のうち PR が merged なら scope/費用の再評価候補を返す。 */
export function computeZeroFindingRoleNotes(internalReview, merged) {
  if (!internalReview || !merged) return [];
  // 最新 marker だけでなく、PR 上の全 marker（re-review 込み）を合計した値で
  // 判定する（`buildInternalReviewSection` の `totalFindings`）。
  return internalReview.roles
    .filter(
      (r) =>
        (r.status === 'reviewed' || r.status === 'ok') &&
        r.coverage === 'complete' &&
        r.totalFindings === 0,
    )
    .map(
      (r) =>
        `${r.role}: 指摘ゼロの role: 月次で scope・費用・独立性を見直し、縮小 / 廃止 / 別手段の候補にする（gardening 手順 4）`,
    );
}

// --- Part 5 結果 -------------------------------------------------------------

/** `Revert` 検索用の argv（`gh pr list --search`）を組む。 */
export function buildRevertSearchArgv(number) {
  return [
    'pr',
    'list',
    '--repo',
    REPO,
    '--state',
    'all',
    '--search',
    `Revert #${number} in:title,body`,
    '--json',
    'number,title',
  ];
}

/** `docs/decisions.md` の全文から、指定番号群のいずれかを含む行だけを抜く。 */
export function collectDecisionLines(raw, numbers) {
  if (raw === null || raw === undefined) return [];
  const needles = (numbers ?? []).map((n) => `#${n}`);
  return String(raw)
    .split('\n')
    .filter((line) => needles.some((needle) => line.includes(needle)))
    .map((line) => line.trim().slice(0, 200));
}

// --- Part 6 所見（heuristics） ----------------------------------------------

/**
 * ヒューリスティックの 4 ケースを上から順に判定し、該当したものだけ返す
 * （どれにも当てはまらなければ空配列 ── §所見 セクション自体を出さない）。
 */
/**
 * @param {{
 *   exploreMedian?: number | null,
 *   codexP1?: number | null,
 *   commitsAfterReady?: number | null,
 *   hasNoEditHeavyModel?: boolean,
 * }} [options]
 */
export function computeFindings({
  exploreMedian = null,
  codexP1 = null,
  commitsAfterReady = null,
  hasNoEditHeavyModel = false,
} = {}) {
  const lines = [];
  if (exploreMedian !== null && exploreMedian > 10) {
    lines.push('探索 turn が多い: brief（ctx --post）の選別漏れを疑う');
  }
  if (codexP1 !== null && codexP1 > 0) {
    lines.push('レビューが P1 を拾った: 判断の記録（DoD / 分解表）に穴が無いか');
  }
  if (commitsAfterReady !== null && commitsAfterReady > 3) {
    lines.push('ready 後の push が多い: push 前セルフレビューの範囲を見直す');
  }
  if (hasNoEditHeavyModel) {
    lines.push(
      'Claude Code telemetry: 編集なしの Opus / Fable session あり（用途と費用を個別確認）',
    );
  }
  return lines;
}

// --- markdown 描画 -----------------------------------------------------------

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

function fmtDate(iso) {
  return iso ? String(iso).slice(0, 10) : null;
}

/** pack（buildTracePack の出力）を markdown へ描画する。空セクションは丸ごと省く。 */
export function renderMarkdown(pack) {
  const lines = [];
  const h = pack.header;
  lines.push(`### trace #${pack.number} ${h.title ?? '（タイトル未取得）'}`);

  const stateLine = [
    `state: ${h.state ?? '未取得'}`,
    `isDraft: ${h.isDraft === null || h.isDraft === undefined ? '未取得' : h.isDraft}`,
    h.mergedAt
      ? `mergedAt: ${fmtDate(h.mergedAt)}`
      : h.closedAt
        ? `closedAt: ${fmtDate(h.closedAt)}`
        : 'mergedAt/closedAt: なし',
    `${h.headRefName ?? '未取得'} → ${h.baseRefName ?? '未取得'}`,
  ];
  lines.push(stateLine.join(' | '));
  if (h.linkedIssues && h.linkedIssues.length > 0) {
    lines.push(`linked issues: ${h.linkedIssues.map((n) => `#${n}`).join(', ')}`);
  }
  lines.push('');
  lines.push(
    '**session telemetry**: Claude Code の local transcript のみ。Antigravity は未収集（不明であり 0 ではない）。PR / review / merge 情報は GitHub 由来の repo 全体で、Claude Code の効率へ帰属させない。',
  );
  lines.push('');

  // #### 見た・実行（session）
  if (pack.sessions === null) {
    lines.push('#### 見た・実行（session）');
    lines.push('');
    lines.push('未取得（Claude Code session log の走査に失敗、または project ディレクトリが無い）');
    lines.push('');
  } else if (pack.sessions.displayed.length > 0) {
    lines.push('#### 見た・実行（session）');
    lines.push('');
    lines.push(
      '| session | 開始 | model 構成 | tool 呼び出し数 | Edit 数 | 探索 turn | subagent 数 |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of pack.sessions.displayed) {
      lines.push(
        `| ${row.sessionId.slice(0, 8)} | ${row.startLabel} | ${escapeCell(row.modelSummary)} | ${row.toolCalls} | ${row.editCalls} | ${row.exploreTurns === null ? '—' : row.exploreTurns} | ${row.subagentCount} |`,
      );
    }
    lines.push('');
    const { summary } = pack.sessions;
    const modelTotalsText =
      [...summary.modelTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, out]) => `${label} ${human(out)}`)
        .join(', ') || 'なし';
    lines.push(
      `**summary**: sessions ${summary.sessionCount} | output tokens: ${modelTotalsText} | Edit 合計 ${summary.totalEdit} | 探索 turn 中央値 ${summary.exploreMedian === null ? '—' : summary.exploreMedian.toFixed(1)}`,
    );
    lines.push('');
  } else {
    lines.push('#### 見た・実行（session）');
    lines.push('');
    lines.push(
      `該当 Claude Code session なし（headRefName: ${h.headRefName ?? '未取得'}。他 provider の実行有無は不明）`,
    );
    lines.push('');
  }

  // #### 判断
  if (pack.judgment) {
    lines.push('#### 判断');
    lines.push('');
    if (pack.judgment.issues.length > 0) {
      for (const issue of pack.judgment.issues) {
        lines.push(`**#${issue.number}**`);
        if (issue.records) {
          lines.push(
            `DoD: ${issue.records.dod ? 'あり' : 'なし'} | 分解表: ${issue.records.breakdown ? 'あり' : 'なし'} | brief: ${issue.records.brief ? 'あり' : 'なし'}`,
          );
          if (issue.dodExcerpt) {
            lines.push(issue.dodExcerpt);
          }
        } else {
          lines.push('未取得（gh 呼び出し失敗）');
        }
        lines.push('');
      }
    } else {
      lines.push('linked issue なし');
      lines.push('');
    }
    lines.push(
      `PR 本文 \`## 検証\`: ${pack.judgment.hasVerificationSection === null ? '未取得' : pack.judgment.hasVerificationSection ? 'あり' : 'なし'}`,
    );
    lines.push('');
  }

  // #### レビュー
  if (pack.review) {
    const r = pack.review;
    lines.push('#### レビュー');
    lines.push('');
    lines.push(`ready_for_review: ${r.readyDate ? fmtDate(r.readyDate) : 'なし'}`);
    lines.push(
      `ready 後の commit 数: ${r.commitsAfterReady === null ? '未取得' : r.commitsAfterReady}`,
    );
    lines.push(
      `レビュー bot 指摘: ${r.codex === null ? '未取得' : `P1 ${r.codex.p1} / P2 ${r.codex.p2}`}`,
    );
    lines.push(
      `未解決 thread: ${r.unresolvedThreads === null || r.unresolvedThreads === undefined ? '未取得' : r.unresolvedThreads}`,
    );
    lines.push(
      `レビュー summary marker: ${r.hasMarker === null ? '未取得' : r.hasMarker ? 'あり' : 'なし'}`,
    );
    // 「投げた回数のわりに指摘が出ない」を月次で見るための 3 数字（#2558 手順 6）。
    lines.push(
      `レビュー起動: ${
        r.codexCycles === null || r.codexCycles === undefined
          ? '未取得'
          : `投稿 ${r.codexCycles.requests} / 応答 ${r.codexCycles.responses} / 問題なし ${r.codexCycles.cleanResponses}`
      }`,
    );
    if (r.internalReview) {
      const ir = r.internalReview;
      lines.push(`内製クロスレビュー（marker ${ir.markerCount} 件）:`);
      if (ir.roles.length > 0) {
        for (const role of ir.roles) {
          const sourceLabel =
            role.findingsSource === 'marker'
              ? 'marker'
              : role.findingsSource === 'estimate'
                ? '推定'
                : 'status により未集計';
          const totalFindings = role.totalFindings === null ? '未取得' : role.totalFindings;
          const latestFindings = role.findings === null ? '未取得' : role.findings;
          lines.push(
            `- ${role.role}: 指摘 合計 ${totalFindings}（marker ${ir.markerCount} 件、最新 ${latestFindings}（${sourceLabel}）） / status ${role.status} / coverage ${role.coverage} / marker 後の commit ${role.commitsAfterMarker === null ? '未取得' : role.commitsAfterMarker}`,
          );
        }
      } else {
        lines.push('- reviewer role なし（docs-only 等の marker）');
      }
    }
    lines.push('');
  }

  // #### 結果
  if (pack.result) {
    const res = pack.result;
    lines.push('#### 結果');
    lines.push('');
    lines.push(`merged: ${res.merged === null ? '未取得' : res.merged ? 'あり' : 'なし'}`);
    lines.push(`revert PR 数: ${res.revertCount === null ? '未取得' : res.revertCount}`);
    if (res.decisionLines.length > 0) {
      lines.push('決定ログ:');
      for (const line of res.decisionLines) lines.push(`- ${escapeCell(line.replace(/^- /, ''))}`);
    } else {
      lines.push('決定ログ: なし');
    }
    lines.push('');
    lines.push('**DoD vs PR 本文（判定は人が行う）**');
    lines.push('');
    lines.push(res.dodBlock?.dodText ? `DoD:\n${res.dodBlock.dodText}` : 'DoD: なし');
    lines.push('');
    lines.push(res.dodBlock?.prBodyHead ? `PR 本文:\n${res.dodBlock.prBodyHead}` : 'PR 本文: なし');
    lines.push('');
  }

  // #### 所見
  if (pack.findings && pack.findings.length > 0) {
    lines.push('#### 所見');
    lines.push('');
    for (const line of pack.findings) lines.push(`- ${line}`);
    lines.push('');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// --- gh 呼び出しを含む組み立て（main からのみ呼ばれる） ---------------------

/** PR 番号から trace pack を組み立てる。各段は独立に fail-closed。 */
export function buildTracePack(options, deps = {}) {
  const {
    execFileImpl,
    readFileImpl = readFileSync,
    listFilesImpl = listJsonlFiles,
    listDirsImpl,
    cwd = process.cwd(),
    projectsDir = PROJECTS_DIR,
  } = deps;
  const { number } = options;

  const pr = tryOr(
    () =>
      runGhJson(
        [
          'pr',
          'view',
          String(number),
          '--json',
          'number,title,state,url,isDraft,mergedAt,closedAt,headRefName,headRefOid,baseRefName,body,commits',
        ],
        { execFileImpl },
      ),
    null,
  );

  const linkedIssues = extractLinkedIssueNumbers(pr?.body ?? '');

  const header = {
    title: pr?.title ?? null,
    state: pr?.state ?? null,
    isDraft: pr?.isDraft ?? null,
    mergedAt: pr?.mergedAt ?? null,
    closedAt: pr?.closedAt ?? null,
    headRefName: pr?.headRefName ?? null,
    headRefOid: pr?.headRefOid ?? null,
    baseRefName: pr?.baseRefName ?? null,
    linkedIssues,
  };

  // --- Part 2: session ---
  const sessionEntries = pr?.headRefName
    ? loadSessionEntriesForBranch({
        projectsDir,
        cwdPrefix: cwd,
        headRefName: pr.headRefName,
        readFileImpl,
        listFilesImpl,
        listDirsImpl,
      })
    : null;
  const sessions = sessionEntries === null ? null : buildSessionSection(sessionEntries);

  // --- Part 3: 判断 ---
  const judgment = {
    issues: linkedIssues.map((n) =>
      tryOr(
        () => {
          const issue = runGhJson(['api', `repos/${REPO}/issues/${n}`], { execFileImpl });
          const comments = runGhJson(['api', `repos/${REPO}/issues/${n}/comments?per_page=100`], {
            execFileImpl,
          });
          const records = detectJudgmentRecords(comments, issue.body ?? '');
          return {
            number: n,
            records,
            dodExcerpt: extractDodExcerpt(
              [issue.body ?? '', ...(comments ?? []).map((c) => c?.body ?? '')].join('\n'),
            ),
          };
        },
        { number: n, records: null, dodExcerpt: '' },
      ),
    ),
    hasVerificationSection: pr ? hasVerificationSection(pr.body ?? '') : null,
  };

  // --- Part 4: レビュー ---
  const timelineEvents = tryOr(
    () =>
      runGhJson(['api', `repos/${REPO}/issues/${number}/timeline`, '--paginate'], {
        execFileImpl,
      }),
    null,
  );
  const readyDate = timelineEvents ? findReadyForReviewDate(timelineEvents) : null;
  let commitsAfterReady = null;
  if (timelineEvents && readyDate) {
    if (timelineLacksCommitEvents(timelineEvents)) {
      commitsAfterReady = tryOr(
        () => countCommitsAfterReadyFallback(pr?.commits ?? [], readyDate),
        null,
      );
    } else {
      commitsAfterReady = countCommitsAfterReady(timelineEvents, readyDate);
    }
  }

  const codexReviews = tryOr(
    () =>
      runGhJson(['api', `repos/${REPO}/pulls/${number}/reviews`, '--paginate'], { execFileImpl }),
    null,
  );
  const codexComments = tryOr(
    () =>
      runGhJson(['api', `repos/${REPO}/pulls/${number}/comments`, '--paginate'], { execFileImpl }),
    null,
  );
  const codex =
    codexReviews === null && codexComments === null
      ? null
      : countReviewPriorities(codexReviews ?? [], codexComments ?? []);

  const threadNodes = tryOr(() => {
    const raw = runGh(
      [
        'api',
        'graphql',
        '-f',
        'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}',
        '-f',
        `owner=${REPO_OWNER}`,
        '-f',
        `name=${REPO_NAME}`,
        '-F',
        `number=${number}`,
      ],
      { execFileImpl },
    );
    return JSON.parse(raw).data.repository.pullRequest.reviewThreads.nodes;
  }, null);
  const unresolvedThreads =
    threadNodes === null ? null : threadNodes.filter((n) => n?.isResolved === false).length;

  const issueComments = tryOr(
    () =>
      runGhJson(['api', `repos/${REPO}/issues/${number}/comments?per_page=100`, '--paginate'], {
        execFileImpl,
      }),
    null,
  );
  const hasMarker = issueComments === null ? null : hasInternalReviewMarker(issueComments);
  const internalReview =
    issueComments === null
      ? null
      : buildInternalReviewSection({
          issueComments,
          reviewComments: codexComments ?? [],
          commits: pr?.commits ?? [],
          headSha: pr?.headRefOid ?? null,
        });

  const review = {
    readyDate,
    commitsAfterReady,
    codex,
    codexCycles: issueComments === null ? null : countReviewRequestCycles(issueComments),
    unresolvedThreads,
    hasMarker,
    internalReview,
  };

  // --- Part 5: 結果 ---
  const revertResults = tryOr(
    () => runGhJson(buildRevertSearchArgv(number), { execFileImpl }),
    null,
  );
  const decisionRaw = tryOr(() => readFileImpl(join(cwd, 'docs/decisions.md'), 'utf8'), null);
  const decisionLines = collectDecisionLines(decisionRaw, [number, ...linkedIssues]);

  const dodIssue = judgment.issues.find((i) => i.dodExcerpt);
  const result = {
    merged: pr ? Boolean(pr.mergedAt) : null,
    revertCount: revertResults === null ? null : revertResults.length,
    decisionLines,
    dodBlock: {
      dodText: dodIssue?.dodExcerpt ?? '',
      prBodyHead: (pr?.body ?? '').split('\n').slice(0, 10).join('\n'),
    },
  };

  // --- Part 6: 所見 ---
  const findings = [
    ...computeFindings({
      exploreMedian: sessions?.summary?.exploreMedian ?? null,
      codexP1: codex?.p1 ?? null,
      commitsAfterReady,
      hasNoEditHeavyModel: hasNoEditHeavyModelSession(sessions?.all ?? []),
    }),
    ...computeZeroFindingRoleNotes(internalReview, result.merged),
  ];

  return {
    number,
    header,
    sessionTelemetryCoverage: SESSION_TELEMETRY_COVERAGE,
    sessions,
    judgment,
    review,
    result,
    findings,
  };
}

// --- CLI --------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pack = buildTracePack(options, {});
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        pack,
        (key, value) => (value instanceof Map ? Object.fromEntries(value) : value),
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${renderMarkdown(pack)}\n`);
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'trace failed');
    process.exitCode = 1;
  }
}
