import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProtectedPathGate } from '../ci/protected-path-gate.mjs';
import { resolveFactoryRoute } from '../lib/factory-routing.mjs';
import { REPO, runGh, runGhJson } from '../lib/gh.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { buildContextInput } from '../lib/jev-assist-context.mjs';

/**
 * Codex GitHub 連携 bot の login。GraphQL の `author.login` は
 * `chatgpt-codex-connector`、REST の `user.login` は `chatgpt-codex-connector[bot]`
 * と表記が割れる。bot コメント除外の例外判定専用で、merge を gate する用途では
 * 使わない（#2596 で issue-review-core.mjs を削除したため、この表示用途だけを
 * ここへ複製する）。
 */
const CODEX_BOT_LOGIN = 'chatgpt-codex-connector';

function isCodexBotLogin(login) {
  return String(login ?? '').replace(/\[bot\]$/, '') === CODEX_BOT_LOGIN;
}

/**
 * `pnpm ctx <N>` — L0 の「context pack」（AGENTS.md 委任・報告の作法 §L0、
 * routing skill §Worker recipe / L0）。`--l1-shadow` は既存Jev assistを明示実行し、
 * 同一入力snapshotを確認したローカルpreviewだけを追加する。通常の読取・投稿ではJevを呼ばない。
 *
 * Uber 原則⑤「AI が考える前に機械的に集められる文脈はここで終える」の Dayopt 写像。
 * AI セッションが issue / PR に着手する前に行う `gh issue view` / `gh pr list` /
 * `rg` / `Read` の 5〜10 手番を、gh の追加呼び出しなしで完結する 1 コマンドへ畳む。
 * 出力は 150 行以内の markdown、判断そのものはしない（判断材料の収集で止める）。
 *
 * 呼び出し予算: issue は最大 6 回、PR は最大 9 回の gh 呼び出しに収める
 * （search prs / graphql の 1 回 + 関連先の pr view を必要な分だけ）。
 *
 * deferred（次回以降）: `--comments` の bot 判定を login 完全一致以外（app slug）
 * まで広げる、`docs/decisions.md` 以外のログ（PR コメント内の decision 言及）の
 * 取り込み、related PR の再帰探索（epic の epic）、`protected-path-gate.mjs` が
 * spawn 経路に変わった場合の追随。
 */

const [REPO_OWNER, REPO_NAME] = REPO.split('/');

/** 配達コメントの先頭に置く隠しマーカー。このマーカーで始まるコメントが「ctx brief」。
 * selectComments / findMarkerComment / detectJudgmentRecords が共通で参照するため
 * ファイル先頭で定義する（元は --post セクションにあったが、独立性ガード（F2）で
 * 上流の selectComments からも参照するようになった）。 */
export const CTX_MARKER = '<!-- ctx-brief -->';

// F2（独立性ガード）: Main 自身が書いた marker / brief コメントが reviewer への
// ctx pack へ紛れ込むと、Main の判断が「独立レビュー」を経由せず reviewer の入力へ
// 混入する。selectComments はこれらを常に除外する（--all-comments 指定時も除外 ──
// bot 除外とは独立した懸念のため）。
// `[review-summary]` は #2562 でレビュー summary コメントの marker になった
// （gate は読まない情報コメント）。旧 `[internal-review]` は過去 PR に残るため
// 併記する。ここは「Main 自身が書いた marker コメントを ctx から除外する」ための
// 一覧で、gate の判定材料ではない。
const OWN_MARKER_PREFIXES = [
  CTX_MARKER,
  '[review-summary]',
  '[internal-review]',
  '[codex-issue-review]',
];

/** body が Main 自身の marker / brief コメントで始まるか。 */
function isOwnMarkerComment(body) {
  if (typeof body !== 'string') return false;
  if (body.startsWith(CTX_MARKER)) return false;
  return OWN_MARKER_PREFIXES.slice(1).some((prefix) => body.startsWith(prefix));
}

// F2: findMarkerComment / detectJudgmentRecords の brief 判定は、なりすまし防止のため
// author_association が OWNER/MEMBER/COLLABORATOR のコメントのみを対象にする
// （誰でも書き込める comment body の prefix 一致だけでは、外部ユーザーが偽の
// marker コメントを投稿して既存 brief の PATCH 更新を乗っ取れてしまう）。
const TRUSTED_MARKER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** comment が信頼できる author_association から投稿された marker コメントか。 */
function isTrustedMarkerComment(comment) {
  return (
    typeof comment?.body === 'string' &&
    comment.body.startsWith(CTX_MARKER) &&
    TRUSTED_MARKER_ASSOCIATIONS.has(comment.author_association)
  );
}

/**
 * Stable JSON for a source snapshot. Trusted ctx-brief comments are removed at every level so
 * posting the brief cannot change the input identity it records. Untrusted marker lookalikes stay.
 */
function canonicalSnapshotValue(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isTrustedMarkerComment(item))
      .map((item) => canonicalSnapshotValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalSnapshotValue(item)]),
    );
  }
  return value;
}

/** Hashes source material independently of its key order and trusted self-generated brief comments. */
export function computeContextSnapshotId(sourceMaterial) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalSnapshotValue(sourceMaterial)))
    .digest('hex');
}

const BRIEF_L1_CATEGORIES = new Set([
  'decision',
  'constraint',
  'open_question',
  'verification_result',
  'status_only',
]);
const BRIEF_L1_FAILURES = new Set([
  'auth_failed',
  'balance_below_floor',
  'balance_unknown',
  'budget_exceeded',
  'customer_verification_required',
  'deferred_after_failure',
  'deferred_after_live',
  'disabled',
  'free_tier_restricted',
  'insufficient_credits',
  'input_too_large',
  'invalid_response',
  'invalid_request',
  'missing_credentials',
  'not_cached',
  'provider_error',
  'rate_limited',
  'timeout',
  'budget_unavailable',
  'budget_below_floor',
  'cooldown',
  'rate_locked',
  'rate_state_invalid',
  'rate_state_unreadable',
  'rate_state_unwritable',
  'budget_exhausted',
  'low_confidence',
  'cache_invalid',
  'incomplete',
]);

function isCanonicalBriefSourceUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith('/Dayopt/dayopt/')
    );
  } catch {
    return false;
  }
}

/**
 * Makes a bounded L1 annotation view from an already available report. An adoption record, complete
 * evaluation, sufficient confidence, and an L0 source reference are all required. Model-authored
 * prose, URLs, SHAs, and verification claims are intentionally discarded.
 * @param {{packId: string, adoptedPackIds?: string[], complete?: boolean, failure?: string,
 * rows?: Array<{id: string, relevance: number, category: string, evaluatedAt: string, confidence: number}>,
 * sources?: Array<{id: string, url: string}>, minimumConfidence?: number}} input
 */
export function buildBriefAnnotations({
  packId,
  adoptedPackIds = [],
  complete = false,
  failure = 'incomplete',
  rows = [],
  sources = [],
  minimumConfidence = 0.7,
}) {
  if (!adoptedPackIds.includes(packId)) return { status: 'not_adopted', rows: [] };
  if (!complete || !Array.isArray(rows) || !Array.isArray(sources)) {
    const reason = BRIEF_L1_FAILURES.has(failure) ? failure : 'incomplete';
    return { status: 'unevaluated', reason, rows: [] };
  }

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const normalized = [];
  for (const row of rows) {
    const confidence = row?.confidence;
    if (
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < minimumConfidence ||
      confidence > 1
    )
      return { status: 'unevaluated', reason: 'low_confidence', rows: [] };
    const source = sourceById.get(row?.id);
    if (
      !source ||
      typeof source.url !== 'string' ||
      !isCanonicalBriefSourceUrl(source.url) ||
      !Number.isFinite(row?.relevance) ||
      row.relevance < 0 ||
      row.relevance > 1 ||
      !BRIEF_L1_CATEGORIES.has(row?.category) ||
      typeof row?.evaluatedAt !== 'string' ||
      !Number.isFinite(Date.parse(row.evaluatedAt))
    )
      return { status: 'unevaluated', reason: 'incomplete', rows: [] };
    normalized.push({
      sourceId: row.id,
      url: source.url,
      category: row.category,
      relevance: row.relevance,
      evaluatedAt: row.evaluatedAt,
    });
  }
  return { status: 'adopted', rows: normalized };
}

const L1_CATEGORY_LABELS = {
  constraint: '制約',
  decision: '決定',
  open_question: '未解決の問い',
  verification_result: '検証結果',
  status_only: '進捗',
};
const L1_CATEGORY_WEIGHT = {
  constraint: 4,
  decision: 3,
  open_question: 2,
  verification_result: 1,
  status_only: 0,
};

/**
 * Creates a local-only, non-authoritative preview after confirming the Jev report used the exact
 * context input collected for this L0 run. The normal brief and --post path never consume it.
 */
export function buildL1ShadowPreview(report, expectedInput) {
  if (
    report?.packId !== 'context-relevance' ||
    report?.mode !== 'shadow' ||
    report?.target?.number !== expectedInput?.number ||
    report?.target?.sha !== expectedInput?.sha ||
    report?.target?.url !== expectedInput?.url ||
    !report?.input ||
    computeContextSnapshotId(report.input) !== computeContextSnapshotId(expectedInput) ||
    !Array.isArray(report.rows) ||
    !Array.isArray(report.omitted) ||
    !Array.isArray(report.missing)
  )
    return {
      status: 'snapshot_mismatch',
      evaluatedCount: 0,
      selectedCount: 0,
      omittedCount: 0,
      candidates: [],
    };

  const sourceById = new Map(
    expectedInput.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const rows = [];
  let invalidCount = 0;
  for (const row of report.rows) {
    const source = sourceById.get(row?.id);
    const valid =
      source &&
      typeof source.id === 'string' &&
      /^[a-zA-Z0-9_-]{1,80}$/.test(source.id) &&
      isCanonicalBriefSourceUrl(source.url) &&
      typeof row?.relevance === 'number' &&
      Number.isFinite(row.relevance) &&
      row.relevance >= 0 &&
      row.relevance <= 1 &&
      typeof row?.category === 'string' &&
      Object.hasOwn(L1_CATEGORY_LABELS, row.category) &&
      typeof row?.evaluatedAt === 'string' &&
      Number.isFinite(Date.parse(row.evaluatedAt));
    if (!valid) {
      invalidCount += 1;
      continue;
    }
    rows.push({
      id: source.id,
      url: source.url,
      updatedAt: source.updatedAt,
      category: row.category,
      categoryLabel: L1_CATEGORY_LABELS[row.category],
      evaluatedAt: row.evaluatedAt,
      relevance: row.relevance,
    });
  }
  rows.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      (L1_CATEGORY_WEIGHT[b.category] ?? 0) - (L1_CATEGORY_WEIGHT[a.category] ?? 0) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.id.localeCompare(b.id),
  );

  const complete = report.complete === true && report.missing.length === 0 && invalidCount === 0;
  const evaluatedCount = rows.length;
  return {
    status: complete ? 'complete' : evaluatedCount > 0 ? 'partial' : 'unevaluated',
    reason: complete
      ? null
      : BRIEF_L1_FAILURES.has(report.rows.find((row) => row?.reason)?.reason)
        ? report.rows.find((row) => row?.reason)?.reason
        : 'incomplete',
    evaluatedCount,
    selectedCount: report.rows.length,
    omittedCount: report.omitted.length,
    candidates: rows.slice(0, 5).map(({ relevance: _relevance, ...candidate }) => candidate),
  };
}

/**
 * Calls the existing Jev shadow entrypoint with argv (never a shell) and parses its JSON report.
 * @param {number} number
 * @param {{cwd?: string, execFileImpl?: (file: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string}} [options]
 */
export function runContextL1ShadowAssist(
  number,
  { cwd = process.cwd(), execFileImpl = execFileSync } = {},
) {
  const stdout = execFileImpl(
    join(cwd, 'node_modules', '.bin', 'tsx'),
    ['scripts/tasks/jev/assist.ts', 'context', '--issue', String(number), '--json'],
    { cwd, encoding: 'utf8', maxBuffer: 2_000_000 },
  );
  return JSON.parse(stdout);
}

function l1ShadowUnavailable(reason = 'assist_unavailable') {
  return {
    status: 'unavailable',
    reason,
    evaluatedCount: 0,
    selectedCount: 0,
    omittedCount: 0,
    candidates: [],
  };
}

function renderL1ShadowPreview(preview) {
  const lines = [
    '',
    '#### L1 Jev shadow preview（助言のみ）',
    '',
    '未採用packのローカル表示。Issueの要求・必須条件・policy・検証条件を変更せず、最終判断もしません。候補から外れた資料を無関係とはみなしません。',
  ];
  if (preview.status === 'complete') {
    lines.push(
      `選択した ${preview.selectedCount} 件を評価済み。候補を最大5件表示（別枠の対象外 ${preview.omittedCount} 件は未評価）。`,
    );
  } else if (preview.status === 'partial') {
    lines.push(
      `部分評価 ${preview.evaluatedCount}/${preview.selectedCount} 件。以下は暫定候補で、全体順位ではありません（対象外 ${preview.omittedCount} 件）。`,
    );
  } else if (preview.status === 'unevaluated') {
    lines.push(`未評価（${preview.reason ?? 'incomplete'}）。候補順位を表示していません。`);
  } else if (preview.status === 'snapshot_mismatch') {
    lines.push(
      'L0とJevの入力snapshotが一致しないため、候補を表示していません。再実行してください。',
    );
  } else {
    lines.push(
      `Jevのshadow結果を取得できません（${preview.reason ?? 'assist_unavailable'}）。L0の結果はそのまま利用できます。`,
    );
  }
  for (const row of preview.candidates ?? [])
    lines.push(`- [${row.id}](${row.url}) | ${row.categoryLabel} | 読む候補（shadow）`);
  if (preview.status === 'complete' && preview.evaluatedCount === 0)
    lines.push('候補はありません。これは問題や関連資料が無いことの証明ではありません。');
  return lines;
}

// --- 純関数群（test 対象） -------------------------------------------------

/** CLI 引数を解釈する。位置引数は issue/PR 番号 1 つのみ。 */
export function parseArgs(argv) {
  const options = {
    number: null,
    json: false,
    comments: 5,
    bodyLines: 60,
    allComments: false,
    post: false,
    l1Shadow: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--all-comments') {
      options.allComments = true;
    } else if (arg === '--post') {
      options.post = true;
    } else if (arg === '--l1-shadow') {
      options.l1Shadow = true;
    } else if (arg === '--comments') {
      options.comments = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--body-lines') {
      options.bodyLines = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(
        `未知の引数です: ${arg}（--json / --comments / --body-lines / --all-comments / --post / --l1-shadow のみ）`,
      );
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) {
    throw new Error('issue/PR 番号を 1 つ指定してください: pnpm ctx <N>');
  }
  if (options.post && options.l1Shadow)
    throw new Error('--l1-shadow はローカルのshadow preview専用で、--postとは併用できません');
  const number = Number(positionals[0]);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`不正な番号です: ${positionals[0]}`);
  }
  if (!Number.isInteger(options.comments) || options.comments < 0) {
    throw new Error('--comments は 0 以上の整数で指定してください');
  }
  if (!Number.isInteger(options.bodyLines) || options.bodyLines < 0) {
    throw new Error('--body-lines は 0 以上の整数で指定してください');
  }
  options.number = number;
  return options;
}

/** `gh api repos/.../issues/N` の応答が PR かどうか（`pull_request` キーの有無）。 */
export function isPullRequest(apiResponse) {
  return Boolean(apiResponse && apiResponse.pull_request);
}

/** body を先頭 maxLines 行へ切り詰める。0 行指定はそのまま全文を返す（切り詰めない）。 */
export function truncateBody(body, maxLines) {
  const text = body ?? '';
  if (!maxLines) return { text, truncated: false, remaining: 0 };
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, truncated: false, remaining: 0 };
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
    remaining: lines.length - maxLines,
  };
}

/** comment 本文を先頭 maxLines 行へ切り詰める（末尾の残り行数表示はしない、素の抜粋）。 */
export function truncateCommentBody(body, maxLines = 8) {
  const lines = (body ?? '').split('\n');
  return lines.slice(0, maxLines).join('\n');
}

/** login が `[bot]` で終わる（GitHub App コメント）かどうか。 */
export function isBotLogin(login) {
  return typeof login === 'string' && login.endsWith('[bot]');
}

/** text 中に「subtask」「tier」列を持つ markdown 表ヘッダ、または「分解表」の語があるか。 */
function hasBreakdownTable(text) {
  if (!text) return false;
  if (text.includes('分解表')) return true;
  return text.split('\n').some((line) => {
    if (!line.includes('|')) return false;
    const lower = line.toLowerCase();
    return lower.includes('subtask') && lower.includes('tier');
  });
}

/** text 中に DoD / 完了の定義 の言及があるか。 */
function hasDodMention(text) {
  return /(DoD|完了の定義)/.test(text ?? '');
}

/**
 * issue/PR の「判断の記録」を判定する（routing skill §目標状態、dispatch 手順 7）。
 * `comments` は REST `issues/N/comments` の生応答（`user.login` / `body`）。
 *
 * - DoD: bot 以外のコメント、または body に `DoD` / `完了の定義` の言及がある
 * - 分解表: コメントまたは body に `subtask`/`tier` 列を持つ表、または「分解表」の語がある
 * - brief: `CTX_MARKER` で始まる、かつ author_association が信頼できる
 *   （OWNER/MEMBER/COLLABORATOR）コメントがある（F2）。bot 判定は問わない ── ctx --post は
 *   通常ユーザー権限の gh 呼び出しで作られ bot login にならないため
 */
export function detectJudgmentRecords(comments, body) {
  const list = Array.isArray(comments) ? comments : [];
  const bodyText = body ?? '';

  // ctx brief 自身（CTX_MARKER で始まるコメント）は DoD/分解表の判定から除外する。
  // brief 本文は「DoD: なし | 分解表: なし」のように判定結果をそのまま描画するため、
  // 除外しないと自分自身の「なし」テキストに含まれる「DoD」「分解表」という語に
  // 一致して true へ誤反転する（自己言及によるフラップ）。`brief` 判定自体は
  // CTX_MARKER コメントの存在そのものを見るため、そちらは全件を対象にする。
  //
  // #2560 項目 6: 除外条件は prefix 一致だけでなく author_association も見る
  // （brief 判定側の isTrustedMarkerComment と揃える）。prefix だけで除外すると、
  // 第三者が `<!-- ctx-brief -->` で始まるコメントを投稿するだけで、そのコメントを
  // 判定対象から外せる。除外したいのは「Main 自身が書いた brief」だけなので、
  // 信頼できない author の marker 風コメントは通常のコメントとして扱う。
  const nonBriefList = list.filter((c) => !isTrustedMarkerComment(c));

  const dod =
    hasDodMention(bodyText) ||
    nonBriefList.some((c) => !isBotLogin(c.user?.login) && hasDodMention(c.body ?? ''));

  const breakdown =
    hasBreakdownTable(bodyText) || nonBriefList.some((c) => hasBreakdownTable(c.body ?? ''));

  const brief = list.some((c) => isTrustedMarkerComment(c));

  return { dod, breakdown, brief };
}

/** text 中の `## やること` セクションに、チェックリスト/箇条書き行が1つ以上あるか。 */
function hasYaruKotoChecklist(text) {
  if (!text) return false;
  const lines = text.split('\n');
  const startIdx = lines.findIndex((line) => /^#{1,6}\s*やること\s*$/.test(line.trim()));
  if (startIdx === -1) return false;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) break; // 次のセクションに入ったら終了
    if (/^\s*[-*]\s*(\[[ xX]\])?\s*\S/.test(line)) return true;
  }
  return false;
}

/**
 * text 中の `## 検証` セクション本文だけを抜き出す（次の `## ` 見出しの直前まで、
 * `###` 以下のサブ見出しは区切りにしない）。見出しが無ければ空文字。
 */
function extractVerificationSection(text) {
  return extractSectionText(text, /^##\s*検証\s*$/) ?? '';
}

/**
 * text 中の `headingRegex` に一致する見出し行の直後から、次の `##` 見出し
 * （`###` 以下のサブ見出しは区切りにしない）の直前までの本文を抜き出す。
 * 見出しが見つからなければ null。
 * @param {string} text
 * @param {RegExp} headingRegex 見出し行（trim 済み）に対する正規表現
 */
function extractSectionText(text, headingRegex) {
  const lines = String(text ?? '').split('\n');
  const startIdx = lines.findIndex((line) => headingRegex.test(line.trim()));
  if (startIdx === -1) return null;
  const sectionLines = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^##(?!#)\s/.test(lines[i])) break; // 次の `##` 見出しに入ったら終了
    sectionLines.push(lines[i]);
  }
  return sectionLines.join('\n').trim();
}

/**
 * issue body から受け入れ条件相当のテキストを抜き出す（PR mode の ctx が linked
 * issue の意図をレビュアーへ見せるために使う）。優先順:
 * 1. `## やること` セクション + `## 検証` セクション（両方あれば両方連結）
 * 2. どちらも無ければ「受け入れ条件」「完了条件」の語を含む行群
 * 何も見つからなければ空文字（呼び出し側はその issue をセクションから省く）。
 * @param {string | undefined | null} body
 */
export function extractAcceptanceCriteriaText(body) {
  const text = body ?? '';
  const parts = [];
  const yaruKoto = extractSectionText(text, /^#{1,6}\s*やること\s*$/);
  if (yaruKoto) parts.push(`## やること\n${yaruKoto}`);
  const kensho = extractSectionText(text, /^##\s*検証\s*$/);
  if (kensho) parts.push(`## 検証\n${kensho}`);
  if (parts.length > 0) return parts.join('\n\n').trim();

  const acceptanceLines = text
    .split('\n')
    .filter((line) => line.includes('受け入れ条件') || line.includes('完了条件'));
  return acceptanceLines.join('\n').trim();
}

/** Keep the canonical request, scope, constraints, and verification text visible outside ranked L1. */
function extractBriefRequiredSections(body) {
  const wanted = new Map([
    ['goal', '要求（Goal）'],
    ['背景', '要求（背景）'],
    ['やること', '実施範囲（やること）'],
    ['minimum viable approach', '実施範囲（Minimum Viable Approach）'],
    ['test and acceptance', '必要な検証（Test and Acceptance）'],
    ['検証', '必要な検証（検証）'],
    ['assumptions and not doing', '制約（Assumptions and Not Doing）'],
    ['注意', '制約（注意）'],
  ]);
  const lines = String(body ?? '').split('\n');
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(lines[index].trim());
    if (!heading) continue;
    const normalized = heading[1].trim().toLowerCase();
    const label = wanted.get(normalized);
    if (!label) continue;
    const content = [];
    for (let next = index + 1; next < lines.length && !/^##(?!#)\s/.test(lines[next]); next += 1)
      content.push(lines[next]);
    const text = content.join('\n').trim();
    if (text) sections.push({ heading: label, text });
  }
  return sections;
}

/**
 * issue body の「受け入れ条件 / 検証コマンド」を判定する（routing skill / dispatch §status:ready）。
 *
 * - acceptance: body に `受け入れ条件` または `完了条件` の語がある、または
 *   `## やること` セクションにチェックリスト/箇条書き行が1つ以上ある
 * - verification: **`## 検証` セクション内だけ**に fenced code block、または
 *   `pnpm `/`gh `/`node `/`git `/`rg `/`npx ` で始まるインラインコード、または
 *   `expect(` の語がある。セクション自体が無ければ false（body 全体への fallback は
 *   しない ── 本文中の無関係な fenced block や日常会話の `pnpm ...` 言及を検証
 *   コマンドと誤認するのを防ぐ）
 */
export function detectAcceptanceCriteria(body) {
  const text = body ?? '';

  const acceptance =
    text.includes('受け入れ条件') || text.includes('完了条件') || hasYaruKotoChecklist(text);

  const verificationSection = extractVerificationSection(text);
  const hasFencedCodeBlock = /```/.test(verificationSection);
  const hasVerificationCommand =
    /`(pnpm|gh|node|git|rg|npx) [^`]*`/.test(verificationSection) ||
    verificationSection.includes('expect(');
  const verification = hasFencedCodeBlock || hasVerificationCommand;

  return { acceptance, verification };
}

/**
 * `detectJudgmentRecords`（+ 任意で `detectAcceptanceCriteria`）の結果から次の一手ヒントを組む。
 * `records` に `acceptance`/`verification` フィールドが無ければその判定はスキップする。
 * 全て あり なら null。
 */
export function buildJudgmentHint(records) {
  if (!records) return null;
  const missing = [];
  if (!records.dod) missing.push('DoD');
  if (!records.breakdown) missing.push('分解表');
  if (!records.brief) missing.push('brief');
  if ('acceptance' in records && !records.acceptance) missing.push('受け入れ条件');
  if ('verification' in records && !records.verification) {
    missing.push('検証コマンド（dispatch §status:ready の機械判定）');
  }
  if (missing.length === 0) return null;
  return `判断の記録が欠けている: ${missing.join('・')}（routing skill 手順 1 / dispatch 手順 7）`;
}

/**
 * REST `issues/N/comments` の応答から、bot を除外（`allComments` 指定時は除外しない）
 * した上で最新 K 件を返す。Main 自身の marker / brief コメント（F2、
 * `isOwnMarkerComment`）は `allComments` の指定に関わらず常に除外する ──
 * これらが reviewer への ctx pack に混入すると独立レビューの前提が崩れるため、
 * bot 除外とは別の懸念として無条件に適用する。
 *
 * **Codex（`isCodexBotLogin`）は bot 除外の対象外にする** ── `[codex-issue-review]`
 * 実装前レビューは Codex 本体（login が `[bot]` で終わる）のコメントとして
 * issue に残るため、bot を一律除外すると次に着手する Main が直前の Codex 指摘を
 * 見落とす（`[internal-review]` / ctx-brief / `[codex-issue-review]` marker 自体は
 * 上の `isOwnMarkerComment` で別枠除外済みなので、ここで通しても二重計上にならない）。
 */
export function selectComments(comments, k, allComments) {
  const list = Array.isArray(comments) ? comments : [];
  const filtered = list.filter((c) => {
    if (typeof c.body === 'string' && c.body.startsWith(CTX_MARKER))
      return !isTrustedMarkerComment(c);
    if (isOwnMarkerComment(c.body)) return false;
    if (allComments) return true;
    return !isBotLogin(c.user?.login) || isCodexBotLogin(c.user?.login);
  });
  return k > 0 ? filtered.slice(-k) : [];
}

// `Closes #1, #2` のようにキーワード 1 つに複数番号が並ぶ形まで拾う。
const LINK_KEYWORD_RE = /\b(?:Closes|Refs|Fixes)\s+((?:#\d+)(?:\s*,\s*#\d+)*)/gi;

/** body 中の `Closes/Refs/Fixes #N` 群から番号を重複無しで抽出する（出現順）。 */
export function extractLinkedIssueNumbers(body) {
  if (!body) return [];
  const found = [];
  const re = new RegExp(LINK_KEYWORD_RE);
  let match = re.exec(body);
  while (match) {
    const nums = match[1].match(/\d+/g) ?? [];
    for (const n of nums) found.push(Number(n));
    match = re.exec(body);
  }
  return [...new Set(found)];
}

/** issue body から親 epic 番号を推定する（`sub-issue of #M` 優先、無ければ `Refs #M` の初出）。 */
export function extractParentEpic(body) {
  if (!body) return null;
  const subIssueMatch = body.match(/sub-issue of #(\d+)/i);
  if (subIssueMatch) return Number(subIssueMatch[1]);
  const refsMatch = body.match(/\bRefs\s+#(\d+)/i);
  if (refsMatch) return Number(refsMatch[1]);
  return null;
}

const PATH_TOKEN_RE = /[\w@./-]+\.(?:ts|tsx|mjs|cjs|js|md|mdx|sql|yml|yaml|json|sh)/g;

/** body からパスらしき token を抽出する（実在確認は呼び出し側 `filterExistingPaths` で行う）。 */
export function extractPathTokens(body) {
  if (!body) return [];
  const matches = body.match(PATH_TOKEN_RE) ?? [];
  return [...new Set(matches)];
}

/** `existsFn` で実在確認できた path だけ残す（`cwd` 起点の相対解決）。 */
export function filterExistingPaths(tokens, existsFn, cwd) {
  return tokens.filter((token) => {
    try {
      return existsFn(join(cwd, token));
    } catch {
      return false;
    }
  });
}

/** ある issue/PR 番号を指す `Closes/Refs/Fixes #N` を body に持つかどうか。 */
export function bodyReferencesNumber(body, number) {
  if (!body) return false;
  const re = new RegExp(`\\b(?:Closes|Refs|Fixes)\\s+(?:#\\d+\\s*,\\s*)*#${number}\\b`, 'i');
  return re.test(body);
}

/**
 * `statusCheckRollup`（CheckRun / StatusContext 混在配列）を SUCCESS/FAILURE/PENDING
 * の 3 分類へ畳む。`conclusion`（CheckRun）→ `state`（StatusContext）→ `status` の順で
 * 読み、値が無い・未知なら pending 扱い（COMPLETED でない CheckRun 等）。
 */
export function computeCiRollup(rollup) {
  const counts = { success: 0, failure: 0, pending: 0 };
  const SUCCESS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const FAILURE = new Set([
    'FAILURE',
    'ERROR',
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
  ]);
  for (const item of rollup ?? []) {
    const raw = String(item?.conclusion ?? item?.state ?? item?.status ?? '').toUpperCase();
    if (SUCCESS.has(raw)) counts.success += 1;
    else if (FAILURE.has(raw)) counts.failure += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** GraphQL `reviewThreads(first:100){nodes{isResolved}}` から未解決 thread 数を数える。 */
export function countUnresolvedThreads(nodes) {
  return (nodes ?? []).filter((n) => n?.isResolved === false).length;
}

// ファイル一覧 → skill 候補の固定ルール表（AGENTS.md Skills 索引と対応）。
const SKILL_RULES = [
  {
    test: (f) => f.startsWith('supabase/migrations/') || f.startsWith('supabase/functions/'),
    skill: 'supabase',
  },
  {
    test: (f) => /^apps\/product\/src\/features\/[^/]+\/server\//.test(f),
    skill: 'trpc-router-creating',
  },
  { test: (f) => /^apps\/product\/src\/features\/[^/]+\/server\//.test(f), skill: 'security' },
  {
    test: (f) =>
      /^apps\/product\/src\/features\/auth\//.test(f) || /\/lib\/(?:stripe|billing)\//.test(f),
    skill: 'security',
  },
  {
    test: (f) => f.endsWith('.stories.tsx') || f.startsWith('packages/components/'),
    skill: 'storybook',
  },
  { test: (f) => f.startsWith('apps/product/messages/'), skill: 'i18n' },
  { test: (f) => f.startsWith('apps/web/content/'), skill: 'docs-writing' },
  { test: (f) => f.endsWith('.test.ts'), skill: 'test' },
  { test: (f) => f.startsWith('docs/'), skill: 'docs-writing' },
];

/** ファイル一覧（+ 保護対象判定）から関連 skill 候補を一意に列挙する。 */
export function mapSkills(files, protectedRequired) {
  const skills = new Set();
  for (const file of files ?? []) {
    for (const rule of SKILL_RULES) {
      if (rule.test(file)) skills.add(rule.skill);
    }
  }
  if (protectedRequired) skills.add('pr-cross-review');
  return [...skills];
}

/**
 * 次の一手のヒューリスティック。上から順に判定し、最初に成立したものを返す。
 * どれにも当てはまらない（例: issue で PR 紐付き済み）場合は空文字（次の一手セクション自体を出さない）。
 *
 * `pnpm branch:finish N` は不可逆操作（merge）の入口なので、**CI rollup（pending/failure
 * 両方が 0）・未解決 thread 数（0）・isDraft（false）の 3 つを全部 gh から取得できた時だけ**
 * 返す（#2530 push 前反証レビュー P2）。`ciFailure` のような部分的な boolean だけを見ると、
 * 「pending がまだ残っている」「gh 呼び出しが落ちて null のまま」を green と誤認して
 * branch:finish を勧めてしまう。CI が pending の時は「待つ」を明示し、いずれかが
 * 未取得（null）の時は判断保留にして fail-closed にする。
 * @param {{
 *   kind: 'issue' | 'pr',
 *   number: number,
 *   hasLinkedPr?: boolean,
 *   isDraft?: boolean | null,
 *   ciRollup?: { success: number, failure: number, pending: number } | null,
 *   unresolvedThreads?: number | null,
 *   mergeStateStatus?: string,
 *   linkedPrNumber?: number | null,
 * }} input
 */
export function nextStep({
  kind,
  number,
  hasLinkedPr = false,
  isDraft = null,
  ciRollup = null,
  unresolvedThreads = null,
  mergeStateStatus = '',
  linkedPrNumber = /** @type {number | null} */ (null),
}) {
  if (kind === 'issue' && !hasLinkedPr) return '分解表を issue コメントに書く（routing skill）';
  if (kind === 'issue' && hasLinkedPr) {
    return linkedPrNumber
      ? `linked PR #${linkedPrNumber} を進める（pnpm ctx ${linkedPrNumber}）`
      : 'linked PR を進める';
  }
  if (kind !== 'pr') return '';

  if (mergeStateStatus === 'DIRTY' || mergeStateStatus === 'BEHIND') {
    return `origin/main を merge して追従する（mergeStateStatus: ${mergeStateStatus}）`;
  }

  const ciFailure = Boolean(ciRollup && ciRollup.failure > 0);
  if (ciFailure) return '失敗 check を直す';

  if (isDraft === true && (unresolvedThreads ?? 0) === 0) {
    return `pnpm check を通して ready 化する（gh pr ready ${number}）`;
  }
  if (isDraft === false && (unresolvedThreads ?? 0) > 0) return 'thread を resolve';

  // #2560 項目 3: draft かつ未解決 thread あり は、上の 2 分岐のどちらにも入らず
  // 末尾の「未取得」へ落ちていた。3 つとも取得できているのに「取得できなかった」と
  // 騙る状態を作らないよう、この組み合わせを名指しで扱う。
  if (isDraft === true && (unresolvedThreads ?? 0) > 0) {
    return `thread を resolve してから ready 化する（未解決 ${unresolvedThreads}、gh pr ready ${number}）`;
  }

  if (ciRollup && ciRollup.pending > 0) {
    return `CI の完走を待つ（pending ${ciRollup.pending}）`;
  }

  const allFetched = ciRollup !== null && unresolvedThreads !== null && isDraft !== null;
  if (
    allFetched &&
    ciRollup.pending === 0 &&
    ciRollup.failure === 0 &&
    unresolvedThreads === 0 &&
    isDraft === false
  ) {
    return `pnpm branch:finish ${number}`;
  }
  // #2560 項目 3: ここへ来るのは ciRollup / unresolvedThreads / isDraft の
  // どれかが実際に null の時だけ（上の分岐で allFetched の組み合わせは尽くしている。
  // ctx.test.ts の網羅 test がこの不変条件を固定する）。
  return '状態が未取得のため判断保留（gh の再実行）';
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatFileList(files, max = 40) {
  if (!files || files.length === 0) return null;
  const shown = files.slice(0, max);
  const rest = files.length - shown.length;
  return { shown, rest };
}

/** pack（buildContextPack の出力）を markdown へ描画する。空セクションは丸ごと省く。 */
const RENDER_MAX_LINES = 150;

/** linked issue の受け入れ条件セクションの既定上限（段階縮小でさらに絞られる）。 */
const LINKED_ISSUE_ACCEPTANCE_DEFAULT_MAX_LINES = 25;

/**
 * 可変セクション（本文・コメント・触るファイル・関連）の表示上限を指定して
 * markdown 行配列を組み立てる。`null` は無制限（省略なし）。
 * 末尾セクション（判断の記録・次の一手・保護対象・関連 skill 候補）は
 * このパラメータでは縮めない ── 呼び出し側（`renderMarkdown`）が
 * 150 行に収まるまで可変セクションだけを段階的に縮める。
 */
function buildMarkdownLines(
  pack,
  {
    bodyMaxLines,
    commentsMax,
    filesMax,
    relatedMax,
    // #2560 項目 5: 決定ログと linked issue の受け入れ条件も段階縮小の対象にする。
    // どちらも以前は縮小対象外で、決定ログに至っては上限すら無かったため、
    // この 2 つが太ると 150 行予算をどの attempt でも守れなかった。
    decisionMax = null,
    acceptanceMaxLines = LINKED_ISSUE_ACCEPTANCE_DEFAULT_MAX_LINES,
  },
) {
  const lines = [];
  lines.push(`### #${pack.number} ${pack.header.title ?? '（タイトル未取得）'}`);

  const headerParts = [
    `種別: ${pack.kind === 'pr' ? 'PR' : 'issue'}`,
    `state: ${pack.header.state ?? '未取得'}`,
    `labels: ${pack.header.labels?.length ? pack.header.labels.join(', ') : 'なし'}`,
    `milestone: ${pack.header.milestone ?? 'なし'}`,
    `assignee: ${pack.header.assignee ?? 'なし'}`,
    `url: ${pack.header.url ?? '未取得'}`,
  ];
  lines.push(headerParts.join(' | '));
  if (pack.snapshotId) {
    lines.push(`生成: ${pack.generatedAt ?? '未取得'} | snapshot: ${pack.snapshotId}`);
  }

  if (pack.kind === 'pr') {
    const ci = pack.header.ciRollup;
    const ciText = ci
      ? `SUCCESS ${ci.success} / FAILURE ${ci.failure} / PENDING ${ci.pending}`
      : '未取得';
    const threadsText =
      pack.header.unresolvedThreads === null || pack.header.unresolvedThreads === undefined
        ? '未取得'
        : String(pack.header.unresolvedThreads);
    lines.push(
      [
        `${pack.header.headRefName ?? '未取得'} → ${pack.header.baseRefName ?? '未取得'}`,
        `head SHA: ${pack.header.headSha ?? '未取得'} | base SHA: ${pack.header.baseSha ?? '未取得'}`,
        `isDraft: ${pack.header.isDraft ?? '未取得'}`,
        `mergeStateStatus: ${pack.header.mergeStateStatus ?? '未取得'}`,
        `reviewDecision: ${pack.header.reviewDecision ?? 'なし'}`,
        `CI: ${ciText}`,
        `未解決 thread: ${threadsText}`,
      ].join(' | '),
    );
  }
  lines.push('');

  if (pack.kind === 'issue') {
    lines.push(
      `Issue本文が要求・制約の正本。以下は該当節の原文で、全文: ${pack.header.url ?? '未取得'} | 本文SHA-256: ${pack.bodySha256 ?? '未取得'}`,
    );
    if (pack.requiredSections?.length) {
      lines.push('#### 要求・制約・必要な検証', '');
      for (const section of pack.requiredSections) {
        const escapedText = escapeHtmlText(section.text).replace(/\r?\n/g, '&#10;');
        lines.push(
          `<details><summary>${escapeHtmlText(section.heading)}（Issue本文の原文）</summary><pre>${escapedText}</pre></details>`,
          '',
        );
      }
    } else {
      lines.push(
        '#### 要求・制約・必要な検証',
        '',
        '該当する標準見出しはありません。Issue本文全文を正本として確認してください。',
        '',
      );
    }

    lines.push('#### 関連PRのrevision・検証', '');
    if (pack.related?.prs === null || pack.related?.prs === undefined) {
      lines.push('関連PR: 未取得');
    } else if (pack.related.prs.length === 0) {
      lines.push('関連PR: なし');
    } else {
      for (const pr of pack.related.prs) {
        const ci = pr.ciRollup
          ? `CI SUCCESS ${pr.ciRollup.success} / FAILURE ${pr.ciRollup.failure} / PENDING ${pr.ciRollup.pending}`
          : 'CI 未取得';
        const detail = pr.detailAvailable ? '' : ` | 詳細 ${pr.detailStatus ?? '未取得'}`;
        lines.push(
          `- #${pr.number} ${pr.state} ${pr.title} | ${pr.url ? `[PR](${pr.url})` : 'URL未取得'} | head SHA ${pr.headSha ?? '未取得'} | base SHA ${pr.baseSha ?? '未取得'} | ${ci}${detail}`,
        );
      }
    }
    lines.push('');
  }

  // --- 本文（可変: bodyMaxLines） ---
  if (pack.body) {
    lines.push('#### 本文');
    lines.push('');
    const fullBodyLines = (pack.body.text || '（本文なし）').split('\n');
    const shownBodyLines =
      bodyMaxLines === null ? fullBodyLines : fullBodyLines.slice(0, bodyMaxLines);
    lines.push(...shownBodyLines);
    const omittedBodyLines = fullBodyLines.length - shownBodyLines.length;
    const remaining = (pack.body.truncated ? (pack.body.remaining ?? 0) : 0) + omittedBodyLines;
    if (remaining > 0) {
      lines.push('');
      lines.push(`…（残り ${remaining} 行）`);
    }
    lines.push('');
  }

  // --- コメント（可変: commentsMax） ---
  if (pack.comments === null) {
    lines.push('#### 直近コメント（最新 K 件）');
    lines.push('');
    lines.push('未取得（gh 呼び出し失敗）');
    lines.push('');
  } else if (pack.comments.length > 0) {
    const shownComments =
      commentsMax === null ? pack.comments : pack.comments.slice(0, commentsMax);
    lines.push(`#### 直近コメント（最新 ${pack.comments.length} 件）`);
    lines.push('');
    for (const comment of shownComments) {
      const source = comment.url ? ` [出典](${comment.url})` : '';
      lines.push(
        `**${comment.author}** (${comment.date})${source} | 実行結果・進捗は自己申告として扱う`,
      );
      lines.push(comment.body);
      lines.push('');
    }
    const omittedComments = pack.comments.length - shownComments.length;
    if (omittedComments > 0) {
      lines.push(`…他 ${omittedComments} 件のコメントは省略（150 行上限）`);
      lines.push('');
    }
  }

  // --- 関連（可変: relatedMax） ---
  const related = pack.related;
  const allRelatedLines = [];
  if (related.parentEpic) {
    allRelatedLines.push(
      `- 親 epic: #${related.parentEpic.number} ${related.parentEpic.state ?? '未取得'} ${related.parentEpic.title ?? ''}`,
    );
  }
  if (related.prs && pack.kind !== 'issue') {
    for (const pr of related.prs) {
      const ci = pr.ciRollup
        ? `CI SUCCESS ${pr.ciRollup.success} / FAILURE ${pr.ciRollup.failure} / PENDING ${pr.ciRollup.pending}`
        : 'CI 未取得';
      allRelatedLines.push(
        `- #${pr.number} ${pr.state} ${pr.title} (${pr.headRefName ?? '未取得'}) | ${pr.url ? `[PR](${pr.url})` : 'URL未取得'} | head SHA ${pr.headSha ?? '未取得'} | base SHA ${pr.baseSha ?? '未取得'} | ${ci}`,
      );
    }
  }
  if (related.linkedIssues) {
    for (const issue of related.linkedIssues) {
      allRelatedLines.push(
        `- #${issue.number} ${issue.state} ${issue.title}${issue.labels?.length ? ` [${issue.labels.join(', ')}]` : ''}`,
      );
    }
  }
  const shownRelatedLines =
    relatedMax === null ? allRelatedLines : allRelatedLines.slice(0, relatedMax);
  if (shownRelatedLines.length > 0) {
    lines.push('#### 関連');
    lines.push('');
    lines.push(...shownRelatedLines);
    const omittedRelated = allRelatedLines.length - shownRelatedLines.length;
    if (omittedRelated > 0) lines.push(`- …他 ${omittedRelated} 件省略（150 行上限）`);
    lines.push('');
  }

  // --- linked issue の受け入れ条件（PR mode のみ。固定で ≤25 行） ---
  // PR 本文が issue の要約を再掲するだけの時、reviewer が issue を別途開かずに
  // 意図（やること / 検証コマンド）を見られるようにする。既に取得済みの
  // `related.linkedIssues[].acceptanceText`（issue 本文の抜粋、追加 gh 呼び出しなし）
  // から組み立てる。25 行を超える分は切り詰める（この pack 全体の 150 行予算を
  // 圧迫しすぎないための固定上限。他の可変セクションのような段階的縮小はしない）。
  if (pack.kind === 'pr' && Array.isArray(pack.related?.linkedIssues)) {
    const withAcceptance = pack.related.linkedIssues
      .filter((issue) => typeof issue.acceptanceText === 'string' && issue.acceptanceText.trim())
      .slice(0, 3);
    if (withAcceptance.length > 0) {
      const sectionBody = [];
      for (const issue of withAcceptance) {
        sectionBody.push(`**#${issue.number} ${issue.title ?? ''}**`);
        sectionBody.push(...issue.acceptanceText.split('\n'));
        sectionBody.push('');
      }
      while (sectionBody.length > 0 && sectionBody[sectionBody.length - 1] === '') {
        sectionBody.pop();
      }
      const heading = ['#### linked issue の受け入れ条件', ''];
      // 見出しと省略行だけで予算を使い切る段（acceptanceMaxLines <= 3）では、
      // 「…（N 行省略）」しか残らないセクションを出しても行数を食うだけなので
      // セクションごと落とす。段階縮小の最終段が実際に 0 行まで縮むようにする。
      // Count the heading, section body, trailing separator, and omission marker inside the limit.
      const budget = Math.max(0, acceptanceMaxLines - heading.length - 2);
      if (budget > 1) {
        let cappedBody = sectionBody;
        if (sectionBody.length > budget) {
          const keep = budget - 1; // 省略行 1 行分を予約する
          cappedBody = sectionBody.slice(0, keep);
          cappedBody.push(`…（${sectionBody.length - keep} 行省略）`);
        }
        lines.push(...heading, ...cappedBody, '');
      }
    }
  }

  // --- 触るファイル（可変: filesMax。ただし 保護対象 line は必ず出す） ---
  const fileList = formatFileList(pack.files);
  if (fileList) {
    const shownFiles = filesMax === null ? fileList.shown : fileList.shown.slice(0, filesMax);
    lines.push('#### 触るファイル');
    lines.push('');
    for (const file of shownFiles) lines.push(`- ${file}`);
    const restCount = fileList.rest + (fileList.shown.length - shownFiles.length);
    if (restCount > 0) lines.push(`- …他 ${restCount} 件`);
    lines.push('');
    lines.push(
      `保護対象: ${pack.protectedRequired === null ? '未取得' : pack.protectedRequired ? '必要' : '不要'}`,
    );
    lines.push('');
  }

  if (pack.decisionLines.length > 0) {
    const shownDecisions =
      decisionMax === null ? pack.decisionLines : pack.decisionLines.slice(0, decisionMax);
    if (shownDecisions.length > 0) {
      lines.push('#### 決定ログ');
      lines.push('');
      for (const line of shownDecisions) lines.push(`- ${escapeCell(line.replace(/^- /, ''))}`);
      const omittedDecisions = pack.decisionLines.length - shownDecisions.length;
      if (omittedDecisions > 0) lines.push(`- …他 ${omittedDecisions} 件省略（150 行上限）`);
      lines.push('');
    }
  }

  // --- 末尾セクション（常に全文表示。ここより上で行数を確保する） ---
  if (pack.routing) {
    lines.push('#### 作業の振り分け（助言・モデル起動なし）', '');
    lines.push(
      `実装・判断: ${pack.routing.level} | 入力充足: ${pack.routing.ready ? 'あり' : '不足'} | 事前整理: ${pack.routing.preparation}`,
    );
    lines.push(`理由: ${pack.routing.reasons.join(' / ')}`);
    lines.push(`不足: ${pack.routing.missing.join(' / ') || 'なし（内容の正しさは担当が確認）'}`);
    lines.push(`事前整理の成果: ${pack.routing.preparationGoal}`, '');
  }
  if (pack.skills.length > 0) {
    lines.push('#### 関連 skill 候補');
    lines.push('');
    lines.push(pack.skills.join(', '));
    lines.push('');
  }

  if (pack.judgmentRecords) {
    const r = pack.judgmentRecords;
    lines.push('#### 判断の記録');
    lines.push('');
    lines.push(
      `DoD: ${r.dod ? 'あり' : 'なし'} | 分解表: ${r.breakdown ? 'あり' : 'なし'} | brief: ${r.brief ? 'あり' : 'なし'} | 受け入れ条件: ${r.acceptance ? 'あり' : 'なし'} | 検証コマンド: ${r.verification ? 'あり' : 'なし'}`,
    );
    lines.push('');
  }

  if (pack.nextStep) {
    lines.push(`次の一手: ${pack.nextStep}`);
    if (pack.nextStepSecondary) {
      lines.push(pack.nextStepSecondary);
    }
  }

  const l1 = pack.l1Annotations;
  if (l1) {
    lines.push('', '#### L1注釈（補助情報）', '');
    if (l1.status === 'adopted') {
      lines.push('採用済みpackの完全評価結果。Issue本文の要求、必須条件、検証を置き換えない。');
      if (l1.rows.length === 0) lines.push('採用済み注釈に表示候補はありません。');
      for (const row of l1.rows)
        lines.push(
          `- [${row.sourceId}](${row.url}) | ${row.category} | 関連度 ${row.relevance.toFixed(2)} | 評価 ${row.evaluatedAt}`,
        );
    } else if (l1.status === 'unevaluated') {
      lines.push(`L1: 未評価（${l1.reason}）。候補順位を表示していません。`);
    } else {
      lines.push('L1: 未採用packのGo記録が無いため未接続。');
    }
  }

  if (pack.l1ShadowPreview) lines.push(...renderL1ShadowPreview(pack.l1ShadowPreview));

  lines.push('', '#### 未確認事項', '');
  if (pack.missingSources?.length) {
    for (const missing of pack.missingSources) lines.push(`- ${missing}`);
  } else {
    lines.push(
      '取得失敗・入力不足はありません。コメントの記述は自己申告、CI表示は各PRごとのGitHub状態です。',
    );
  }

  // 末尾の空行を畳んで行数を安定させる。
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * pack（buildContextPack の出力）を markdown へ描画する。空セクションは丸ごと省く。
 *
 * **150 行保証**: 末尾セクション（判断の記録・次の一手・保護対象・関連 skill 候補）は
 * 「次の一手」を落とすと呼び出し側が何もできなくなるため、常に全文を残す。可変
 * セクション（本文 → コメント → 触るファイル → 関連 → 決定ログ → linked issue の
 * 受け入れ条件の順）を段階的に切り詰めながら 150 行以内に収まる組み合わせが
 * 見つかるまで再描画する。
 *
 * #2560 項目 5: 決定ログと linked issue の受け入れ条件は以前どの attempt でも
 * 縮まなかった（決定ログは上限すら無かった）。この 2 つが太ると 150 行を守れず、
 * しかも黙って超過版を返していたため、呼び出し側は予算超過に気づけなかった。
 * 縮小対象へ加えたうえで、最後まで収まらなければ warn で 1 行知らせる。
 *
 * @param {object} pack
 * @param {{ warn?: (message: string) => void }} [options] warn は test 用の注入点
 */
export function renderMarkdown(pack, { warn = defaultRenderWarn } = {}) {
  const attempts = [
    { bodyMaxLines: null, commentsMax: null, filesMax: null, relatedMax: null },
    { bodyMaxLines: 40, commentsMax: null, filesMax: null, relatedMax: null },
    { bodyMaxLines: 10, commentsMax: null, filesMax: null, relatedMax: null },
    { bodyMaxLines: 0, commentsMax: null, filesMax: null, relatedMax: null },
    { bodyMaxLines: 0, commentsMax: 5, filesMax: null, relatedMax: null },
    { bodyMaxLines: 0, commentsMax: 1, filesMax: null, relatedMax: null },
    { bodyMaxLines: 0, commentsMax: 0, filesMax: null, relatedMax: null },
    { bodyMaxLines: 0, commentsMax: 0, filesMax: 10, relatedMax: null },
    { bodyMaxLines: 0, commentsMax: 0, filesMax: 0, relatedMax: null },
    { bodyMaxLines: 0, commentsMax: 0, filesMax: 0, relatedMax: 5 },
    { bodyMaxLines: 0, commentsMax: 0, filesMax: 0, relatedMax: 0 },
    // ここから先は #2560 項目 5 で足した段。決定ログ → 受け入れ条件の順に削る
    // （決定ログは「今の判断」より前の履歴なので先に落とす）。
    { bodyMaxLines: 0, commentsMax: 0, filesMax: 0, relatedMax: 0, decisionMax: 5 },
    { bodyMaxLines: 0, commentsMax: 0, filesMax: 0, relatedMax: 0, decisionMax: 0 },
    {
      bodyMaxLines: 0,
      commentsMax: 0,
      filesMax: 0,
      relatedMax: 0,
      decisionMax: 0,
      acceptanceMaxLines: 10,
    },
    {
      bodyMaxLines: 0,
      commentsMax: 0,
      filesMax: 0,
      relatedMax: 0,
      decisionMax: 0,
      acceptanceMaxLines: 0,
    },
  ];

  let rendered = '';
  for (const attempt of attempts) {
    rendered = buildMarkdownLines(pack, attempt).join('\n');
    if (rendered.split('\n').length <= RENDER_MAX_LINES) return rendered;
  }
  // 末尾セクション（判断の記録・次の一手・保護対象・関連 skill 候補）だけで
  // 予算を超える異常系。落とすと呼び出し側が何もできなくなるため超過版を返すが、
  // 黙って返さない。
  warn(
    `[ctx] 150 行に収まりませんでした（${rendered.split('\n').length} 行）。末尾セクションだけで予算を超えています。`,
  );
  return rendered;
}

/** renderMarkdown の既定の警告先。stdout の brief 本文を汚さないよう stderr へ書く。 */
function defaultRenderWarn(message) {
  process.stderr.write(`${message}\n`);
}

// --- gh 呼び出しを含む組み立て（main からのみ呼ばれる） ---------------------

/** 例外を握り潰して fallback を返す薄いラッパー。「未取得」を作るための唯一の場所。 */
function tryOr(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const DECISIONS_PATH = 'docs/decisions.md';

function decisionLinesFromText(raw, numbers, truncate = true) {
  const needles = numbers.map((n) => `#${n}`);
  return raw
    .split('\n')
    .filter((line) => needles.some((needle) => line.includes(needle)))
    .map((line) => (truncate ? line.trim().slice(0, 200) : line.trim()));
}

function collectDecisionLines(readFileImpl, cwd, numbers, truncate = true) {
  const raw = tryOr(() => readFileImpl(join(cwd, DECISIONS_PATH), 'utf8'), null);
  return raw === null ? [] : decisionLinesFromText(raw, numbers, truncate);
}

// GraphQL ページングの安全上限（無限ループ防止。100 件 × 30 頁 = 3000 thread は
// 実運用で到達しない想定値）。
const REVIEW_THREADS_PAGE_LIMIT = 30;

/**
 * PR の `reviewThreads` を `pageInfo{hasNextPage endCursor}` で全ページ取得する。
 * `first:100` 1 回だけでは 100 件を超える PR（大規模 diff の long-running review）で
 * 未解決 thread を過小計上し、`nextStep` の branch:finish 判定を誤らせる。
 * @param {number} number
 * @param {import('../lib/gh.mjs').ExecFileImpl | undefined} execFileImpl
 */
function fetchAllReviewThreadNodes(number, execFileImpl) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < REVIEW_THREADS_PAGE_LIMIT; page += 1) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100, after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}`,
      '-f',
      `owner=${REPO_OWNER}`,
      '-f',
      `name=${REPO_NAME}`,
      '-F',
      `number=${number}`,
    ];
    if (after) args.push('-f', `after=${after}`);
    const raw = runGh(args, { execFileImpl });
    const reviewThreads = JSON.parse(raw).data.repository.pullRequest.reviewThreads;
    nodes.push(...(reviewThreads?.nodes ?? []));
    if (!reviewThreads?.pageInfo?.hasNextPage) break;
    after = reviewThreads.pageInfo.endCursor;
  }
  return nodes;
}

/**
 * issue/PR 番号から context pack を組み立てる。gh 呼び出しは各段で `tryOr` により
 * 個別に fail closed（そのセクションだけ「未取得」）にする ── 1 回の flake で
 * 全体を落とさない。
 */
export function buildContextPack(options, deps = {}) {
  const {
    execFileImpl,
    existsFn = existsSync,
    readFileImpl = readFileSync,
    cwd = process.cwd(),
    now = () => new Date(),
    adoptedPackIds = [],
    l1Report = null,
  } = deps;
  const { number, comments: commentsK, bodyLines, allComments } = options;

  const base = tryOr(
    () => runGhJson(['api', `repos/${REPO}/issues/${number}`], { execFileImpl }),
    null,
  );
  const kind = base && isPullRequest(base) ? 'pr' : 'issue';

  let header;
  let rawBody;
  let files = null;
  let ciRollup = null;
  let unresolvedThreads = null;
  let metadataAvailable = base !== null;

  if (kind === 'pr') {
    const pr = tryOr(
      () =>
        runGhJson(
          [
            'pr',
            'view',
            String(number),
            '--json',
            'number,title,state,url,labels,milestone,assignees,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,body,files',
          ],
          { execFileImpl },
        ),
      null,
    );
    metadataAvailable = pr !== null;
    header = {
      title: pr?.title ?? base?.title ?? null,
      state: pr?.state ?? base?.state ?? null,
      labels: (pr?.labels ?? base?.labels ?? []).map((l) => l.name),
      milestone: pr?.milestone?.title ?? base?.milestone?.title ?? null,
      assignee: (pr?.assignees ?? base?.assignees ?? [])[0]?.login ?? null,
      url: pr?.url ?? base?.html_url ?? null,
      updatedAt: base?.updated_at ?? null,
      headRefName: pr?.headRefName ?? null,
      baseRefName: pr?.baseRefName ?? null,
      headSha: pr?.headRefOid ?? null,
      baseSha: pr?.baseRefOid ?? null,
      isDraft: pr?.isDraft ?? null,
      mergeStateStatus: pr?.mergeStateStatus ?? null,
      reviewDecision: pr?.reviewDecision ?? null,
      ciRollup: pr ? computeCiRollup(pr.statusCheckRollup) : null,
      unresolvedThreads: null,
    };
    rawBody = pr?.body ?? base?.body ?? '';
    files = pr?.files?.map((f) => f.path) ?? null;
    ciRollup = header.ciRollup;

    const threadNodes = tryOr(() => fetchAllReviewThreadNodes(number, execFileImpl), null);
    unresolvedThreads = threadNodes === null ? null : countUnresolvedThreads(threadNodes);
    header.unresolvedThreads = unresolvedThreads;
  } else {
    header = {
      title: base?.title ?? null,
      state: base?.state ?? null,
      labels: (base?.labels ?? []).map((l) => l.name),
      milestone: base?.milestone?.title ?? null,
      assignee: (base?.assignees ?? [])[0]?.login ?? null,
      url: base?.html_url ?? null,
      updatedAt: base?.updated_at ?? null,
    };
    rawBody = base?.body ?? '';
  }

  const bodyResult = truncateBody(rawBody, bodyLines);

  const commentsRaw = tryOr(() => {
    const raw = runGhJson(
      ['api', `repos/${REPO}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp'],
      { execFileImpl },
    );
    // `--slurp` returns one array per page. Flatten so every collected comment participates in
    // snapshot freshness and paging does not depend on the caller mode.
    return Array.isArray(raw) ? raw.flat() : null;
  }, null);
  const comments =
    commentsRaw === null
      ? null
      : selectComments(commentsRaw, commentsK, allComments).map((c) => ({
          id: c.id ?? null,
          author: c.user?.login ?? '不明',
          date: (c.created_at ?? '').slice(0, 10),
          url: c.id ? `https://github.com/${REPO}/issues/${number}#issuecomment-${c.id}` : null,
          body: truncateCommentBody(c.body),
        }));

  // --- 関連 ---
  const related = { parentEpic: null, prs: null, linkedIssues: null };
  const assistRelated = [];
  let linkedNumbers = [];

  if (kind === 'issue') {
    related.parentEpic = tryOr(() => {
      const epicNumber = extractParentEpic(rawBody);
      if (!epicNumber) return null;
      const epic = runGhJson(['api', `repos/${REPO}/issues/${epicNumber}`], { execFileImpl });
      assistRelated.push(epic);
      return { number: epicNumber, state: epic.state, title: epic.title };
    }, null);

    const matchedPrs = tryOr(() => {
      const results = runGhJson(
        [
          'search',
          'prs',
          '--repo',
          REPO,
          `#${number}`,
          '--json',
          'number,title,state,url,body,updatedAt',
          '--limit',
          '20',
        ],
        { execFileImpl },
      );
      return results.filter((pr) => bodyReferencesNumber(pr.body, number));
    }, null);

    if (matchedPrs !== null) {
      assistRelated.push(...matchedPrs);
      // 触るファイル用に上位 3 件だけ headRefName + files を追加取得する。
      const enriched = matchedPrs.slice(0, 3).map((pr) =>
        tryOr(
          () => {
            const detail = runGhJson(
              [
                'pr',
                'view',
                String(pr.number),
                '--json',
                'url,headRefName,baseRefName,headRefOid,baseRefOid,statusCheckRollup,updatedAt,files',
              ],
              {
                execFileImpl,
              },
            );
            return {
              ...pr,
              url: detail.url ?? pr.url ?? null,
              headRefName: detail.headRefName,
              baseRefName: detail.baseRefName ?? null,
              headSha: detail.headRefOid ?? null,
              baseSha: detail.baseRefOid ?? null,
              updatedAt: detail.updatedAt ?? pr.updatedAt ?? null,
              ciRollup: Array.isArray(detail.statusCheckRollup)
                ? computeCiRollup(detail.statusCheckRollup)
                : null,
              detailAvailable: true,
              detailStatus: 'available',
              files: detail.files?.map((f) => f.path) ?? [],
            };
          },
          {
            ...pr,
            url: pr.url ?? null,
            headRefName: null,
            baseRefName: null,
            headSha: null,
            baseSha: null,
            updatedAt: pr.updatedAt ?? null,
            ciRollup: null,
            detailAvailable: false,
            detailStatus: 'unavailable',
            files: [],
          },
        ),
      );
      const unexpanded = matchedPrs.slice(3).map((pr) => ({
        ...pr,
        url: pr.url ?? null,
        headRefName: null,
        baseRefName: null,
        headSha: null,
        baseSha: null,
        updatedAt: pr.updatedAt ?? null,
        ciRollup: null,
        detailAvailable: false,
        detailStatus: 'not_expanded',
        files: [],
      }));
      related.prs = [...enriched, ...unexpanded].map(
        ({
          number: n,
          state,
          title,
          url,
          headRefName,
          baseRefName,
          headSha,
          baseSha,
          updatedAt,
          ciRollup,
          detailAvailable,
          detailStatus,
        }) => ({
          number: n,
          state,
          title,
          url,
          headRefName,
          baseRefName,
          headSha,
          baseSha,
          updatedAt,
          ciRollup,
          detailAvailable,
          detailStatus,
        }),
      );
      files = [...new Set(enriched.flatMap((pr) => pr.files))];
    }
  } else {
    linkedNumbers = extractLinkedIssueNumbers(rawBody);
    if (linkedNumbers.length > 0) {
      related.linkedIssues = linkedNumbers.map((n) =>
        tryOr(
          () => {
            const issue = runGhJson(['api', `repos/${REPO}/issues/${n}`], { execFileImpl });
            assistRelated.push(issue);
            return {
              number: n,
              state: issue.state,
              title: issue.title,
              labels: (issue.labels ?? []).map((l) => l.name),
              // 追加の gh 呼び出しは発生しない ── issue 本文は上の呼び出しに
              // 既に含まれている。「#### linked issue の受け入れ条件」用。
              acceptanceText: extractAcceptanceCriteriaText(issue.body),
            };
          },
          { number: n, state: '未取得', title: '未取得', labels: [], acceptanceText: '' },
        ),
      );
    }
  }

  // --- 触るファイル（issue は関連 PR の files + body 中の実在 path token） ---
  if (kind === 'issue') {
    const tokens = extractPathTokens(rawBody);
    const existing = filterExistingPaths(tokens, existsFn, cwd);
    files = [...new Set([...(files ?? []), ...existing])];
  }

  const protectedRequired = files === null ? null : resolveProtectedPathGate(files).required;
  const skills = mapSkills(files ?? [], protectedRequired === true);

  const decisionNumbers = [
    number,
    ...(related.parentEpic ? [related.parentEpic.number] : []),
    ...linkedNumbers,
  ];
  const decisionsRaw = tryOr(() => readFileImpl(join(cwd, DECISIONS_PATH), 'utf8'), null);
  const decisionLinesFull =
    decisionsRaw === null ? [] : decisionLinesFromText(decisionsRaw, decisionNumbers, false);
  const decisionLines = decisionLinesFull.map((line) => line.slice(0, 200));
  const missingSources = [
    ...(base === null || !header.url ? ['primary_metadata_unavailable'] : []),
    ...(commentsRaw === null ? ['comments_unavailable'] : []),
    ...(kind === 'issue' && related.prs === null ? ['related_prs_unavailable'] : []),
    ...(kind === 'issue' && extractParentEpic(rawBody) && !related.parentEpic
      ? ['parent_issue_unavailable']
      : []),
    ...(related.prs ?? [])
      .filter((pr) => !pr.detailAvailable)
      .map((pr) => `related_pr_${pr.number}_details_${pr.detailStatus ?? 'unavailable'}`),
    ...(kind === 'pr' && unresolvedThreads === null ? ['review_threads_unavailable'] : []),
    ...(decisionsRaw === null ? ['decisions_unavailable'] : []),
    ...(related.linkedIssues ?? [])
      .filter((item) => item.state === '未取得')
      .map((item) => `linked_issue_${item.number}_unavailable`),
  ];
  const snapshotMaterial = {
    target: {
      number,
      kind,
      title: header.title,
      state: header.state,
      labels: header.labels,
      milestone: header.milestone,
      assignee: header.assignee,
      url: header.url,
      bodySha256: createHash('sha256').update(rawBody).digest('hex'),
    },
    comments:
      commentsRaw === null
        ? null
        : selectComments(commentsRaw, Number.MAX_SAFE_INTEGER, true).map((comment) => ({
            id: comment.id ?? null,
            url: comment.html_url ?? null,
            author: comment.user?.login ?? null,
            authorAssociation: comment.author_association ?? null,
            createdAt: comment.created_at ?? null,
            updatedAt: comment.updated_at ?? null,
            body: comment.body ?? '',
          })),
    related: {
      parentEpic: related.parentEpic,
      prs: related.prs,
      linkedIssues: related.linkedIssues,
    },
    decisions: decisionsRaw === null ? null : decisionLinesFull,
    missingSources,
  };
  const snapshotId = computeContextSnapshotId(snapshotMaterial);
  const l1Annotations = buildBriefAnnotations(
    l1Report ?? {
      packId: 'context-relevance',
      adoptedPackIds,
      complete: false,
      failure: 'not_cached',
      rows: [],
      sources: [],
    },
  );

  // closed/merged PR は「関連」には出すが、次の一手を駆動しない ── 別の
  // linked PR がまだ open で進行中の可能性や、closed PR が issue を解決しなかった
  // 可能性があるため、closed/merged を「対応済み」とみなして次の一手を空にすると
  // 進行中の作業を見落とす（#2530 push 前反証レビュー P2）。
  const openLinkedPrs = (related.prs ?? []).filter((pr) => pr.state === 'OPEN');
  const hasLinkedPr = kind === 'issue' && openLinkedPrs.length > 0;
  const step = nextStep({
    kind,
    number,
    hasLinkedPr,
    isDraft: header.isDraft,
    ciRollup,
    unresolvedThreads,
    mergeStateStatus: header.mergeStateStatus ?? '',
    linkedPrNumber: hasLinkedPr ? (openLinkedPrs[0]?.number ?? null) : null,
  });

  // 判断の記録（routing skill §目標状態 / dispatch 手順 7）。issue のみ判定する
  // （PR 側は trace.mjs が linked issue ごとに同じ detector を使い分ける）。
  const judgmentRecords =
    kind === 'issue'
      ? {
          ...detectJudgmentRecords(commentsRaw ?? [], rawBody),
          ...detectAcceptanceCriteria(rawBody),
        }
      : null;
  const judgmentHint = buildJudgmentHint(judgmentRecords);
  const criteria = detectAcceptanceCriteria(rawBody);
  const routing = resolveFactoryRoute({
    files,
    labels: header.labels,
    body: rawBody,
    ...criteria,
    metadataAvailable,
    state: header.state,
  });
  let finalNextStep = step;
  let nextStepSecondary = null;
  if (judgmentHint) {
    if (kind === 'issue' && !hasLinkedPr) {
      finalNextStep = judgmentHint;
    } else {
      nextStepSecondary = judgmentHint;
    }
  }

  return {
    number,
    kind,
    ...(options.assist
      ? {
          assistSource: {
            title: header.title,
            body: rawBody,
            url: header.url,
            // GitHub may advance Issue updated_at when this brief comment is posted. Use created_at
            // for this body candidate; body edits still change the candidate text/cache key.
            updatedAt: base?.created_at ?? null,
            comments:
              commentsRaw === null
                ? null
                : selectComments(commentsRaw, Number.MAX_SAFE_INTEGER, allComments),
            related: assistRelated,
            decisions: decisionLinesFull,
            missing: missingSources,
          },
        }
      : {}),
    bodySha256: createHash('sha256').update(rawBody).digest('hex'),
    snapshotId,
    generatedAt: now().toISOString(),
    requiredSections: kind === 'issue' ? extractBriefRequiredSections(rawBody) : [],
    missingSources,
    l1Annotations,
    header,
    body: bodyResult,
    comments,
    related,
    files,
    protectedRequired,
    decisionLines,
    skills,
    judgmentRecords,
    routing,
    nextStep: finalNextStep,
    nextStepSecondary,
  };
}

// --- `--post`（issue/PR コメントへの配達、idempotent 更新） ----------------
// CTX_MARKER の定義はファイル先頭（selectComments / detectJudgmentRecords と共用）。

/** コメント本文を組み立てる。1 行目は必ずマーカー（idempotent 判定の唯一の根拠）。 */
export function buildCommentBody({ number, date, generatedAt, snapshotId, markdown }) {
  const timestamp = generatedAt ?? `${date ?? '未取得'}T00:00:00.000Z`;
  return `${CTX_MARKER}\n**Issue Context Brief（\`pnpm ctx ${number}\`）**\n生成: ${timestamp} | snapshot: ${snapshotId ?? '未取得'}\n\n${markdown}\n`;
}

function sameBriefContentIgnoringGeneratedTime(current, candidate) {
  const normalize = (body) => body.replace(/^生成: .*?( \| snapshot: )/gm, '生成: <timestamp>$1');
  return normalize(current ?? '') === normalize(candidate ?? '');
}

/**
 * コメント一覧からマーカー付きの既存 ctx brief コメントを探す。無ければ null。
 * F2: author_association が OWNER/MEMBER/COLLABORATOR のコメントのみ対象にする
 * ── そうしないと第三者が偽の marker コメントを投稿して PATCH 更新（--post）を
 * 乗っ取れる（別ユーザーのコメントを書き換えてしまう）。
 *
 * **`authLogin` と一致する comment だけを対象にする** ── author_association の
 * trust check だけでは、認証済みだが別ユーザー（OWNER/MEMBER/COLLABORATOR は
 * 複数人いうる）の ctx brief marker を Main が PATCH で書き換えてしまう。
 * `authLogin` が未取得（`gh api user` 失敗）なら fail-open で常に null を返し
 * （＝既存コメントを対象にせず新規作成へ倒す）、他ユーザーの brief を誤って
 * 書き換えるより新規コメントが増える方を選ぶ。
 * @param {Array<{id?: number, body?: string, author_association?: string, user?: {login?: string}}> | undefined} comments
 * @param {string | null} authLogin
 */
export function findMarkerComment(comments, authLogin) {
  if (!authLogin) return null;
  const list = Array.isArray(comments) ? comments : [];
  return list.find((c) => isTrustedMarkerComment(c) && c?.user?.login === authLogin) ?? null;
}

/**
 * 投稿方法（PATCH で更新 / 新規作成）を argv 配列へ落とす。
 * body は tmpFile（os.tmpdir() 配下）経由で渡す ── shell 文字列に埋め込まない。
 */
export function buildPostArgs({ number, existingCommentId, tmpFile }) {
  if (existingCommentId) {
    return {
      mode: 'update',
      argv: [
        'api',
        '-X',
        'PATCH',
        `repos/${REPO}/issues/comments/${existingCommentId}`,
        '-F',
        `body=@${tmpFile}`,
      ],
    };
  }
  return {
    mode: 'create',
    argv: ['issue', 'comment', String(number), '--body-file', tmpFile],
  };
}

/**
 * `pnpm ctx N --post`: markdown を組み立てた後、issue/PR コメントとして配達する。
 * idempotent ── 既存の ctx brief コメント（`CTX_MARKER` で始まる）があれば PATCH で
 * 更新し、無ければ新規作成する。gh 呼び出しは `execFileImpl` 経由（shell を経由しない）。
 */
export function postContextBrief(pack, markdown, deps = {}) {
  const {
    execFileImpl,
    writeFileImpl = writeFileSync,
    mkdtempImpl = mkdtempSync,
    tmpDirPath = tmpdir(),
    now = () => new Date(),
    getCurrentSnapshotId,
  } = deps;

  if (pack.snapshotId && !pack.header?.url)
    throw new Error('対象Issue/PRのURLが未取得のためbriefを投稿できません');

  const existingComments = runGhJson(
    ['api', `repos/${REPO}/issues/${pack.number}/comments?per_page=100`, '--paginate', '--slurp'],
    { execFileImpl },
  );
  // 認証ユーザーの login を 1 回だけ取得する。取得失敗（gh 未認証等）は fail-open で
  // null にし、`findMarkerComment` 側で「既存コメントを対象にせず新規作成」へ倒す
  // （他ユーザーの brief を誤って PATCH するより安全）。
  const authLogin = tryOr(
    () => runGh(['api', 'user', '--jq', '.login'], { execFileImpl }).trim(),
    null,
  );
  const existing = findMarkerComment(
    Array.isArray(existingComments) ? existingComments.flat() : [],
    authLogin,
  );

  const assertFreshSnapshot = () => {
    if (!pack.snapshotId) return;
    if (typeof getCurrentSnapshotId !== 'function')
      throw new Error('投稿前のsnapshot再確認関数がありません');
    const currentSnapshotId = getCurrentSnapshotId(pack);
    if (currentSnapshotId !== pack.snapshotId)
      throw new Error(
        `投稿前に入力snapshotが変化しました（${pack.snapshotId} → ${currentSnapshotId ?? '未取得'}）。briefを再生成してください`,
      );
  };
  const body = buildCommentBody({
    number: pack.number,
    generatedAt: pack.generatedAt ?? now().toISOString(),
    snapshotId: pack.snapshotId,
    markdown,
  });

  if (existing && sameBriefContentIgnoringGeneratedTime(existing.body, body)) {
    assertFreshSnapshot();
    return { mode: 'unchanged', url: existing.html_url ?? null };
  }

  const dir = mkdtempImpl(join(tmpDirPath, 'ctx-brief-'));
  const tmpFile = join(dir, 'body.md');
  writeFileImpl(tmpFile, body, 'utf8');

  // Collect again after the draft is ready and directly before the GitHub mutation. The generated
  // marker itself is excluded from the snapshot, so creation/update remains idempotent.
  assertFreshSnapshot();

  const { mode, argv } = buildPostArgs({
    number: pack.number,
    existingCommentId: existing?.id ?? null,
    tmpFile,
  });

  if (mode === 'update') {
    const updated = runGhJson(argv, { execFileImpl });
    return { mode, url: updated?.html_url ?? existing?.html_url ?? null };
  }
  const out = runGh(argv, { execFileImpl });
  return { mode, url: out.trim() };
}

// --- CLI --------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));
  let pack;
  if (options.l1Shadow) {
    const cwd = process.cwd();
    let headSha = null;
    try {
      headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    } catch {
      // L0 remains usable even when Git metadata is unavailable for the optional L1 preview.
    }
    if (!headSha) {
      pack = buildContextPack(options, { cwd });
      pack.l1ShadowPreview = l1ShadowUnavailable('public_commit_required');
    } else {
      const assistOptions = { ...options, assist: true };
      const l0WithAssistInput = buildContextPack(assistOptions, {
        cwd,
        readFileImpl: (path) => {
          if (!path.endsWith(DECISIONS_PATH)) throw new Error('対象外の資料');
          return execFileSync('git', ['show', `${headSha}:${DECISIONS_PATH}`], {
            cwd,
            encoding: 'utf8',
          });
        },
      });
      try {
        const expectedInput = buildContextInput(
          options.number,
          headSha,
          l0WithAssistInput.assistSource,
        );
        const report = runContextL1ShadowAssist(options.number, { cwd });
        l0WithAssistInput.l1ShadowPreview = buildL1ShadowPreview(report, expectedInput);
      } catch {
        l0WithAssistInput.l1ShadowPreview = l1ShadowUnavailable();
      }
      delete l0WithAssistInput.assistSource;
      pack = l0WithAssistInput;
    }
  } else {
    pack = buildContextPack(options, {});
  }
  if (options.post) {
    const markdown = renderMarkdown(pack);
    const result = postContextBrief(pack, markdown, {
      getCurrentSnapshotId: () => buildContextPack(options, {}).snapshotId,
    });
    process.stdout.write(
      `${result.mode === 'update' ? '更新' : result.mode === 'unchanged' ? '変更なし' : '作成'}: ${result.url ?? '（URL 未取得）'}\n`,
    );
    return;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderMarkdown(pack)}\n`);
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'ctx failed');
    process.exitCode = 1;
  }
}
