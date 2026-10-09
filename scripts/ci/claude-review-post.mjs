#!/usr/bin/env node
/**
 * Claude review（`.github/workflows/claude-review.yml`）の結果を PR へ投稿する決定的な step。
 *
 * モデルは GitHub への書き込み権限を持たず、structured output（findings の JSON）だけを返す。
 * この script が review policy（`scripts/lib/review-policy.mjs`）の読む形へ固定する:
 * - PR review（event COMMENT、commit_id = workflow が checkout した head）。inline comment は
 *   diff の RIGHT 側に存在する行だけに付け、それ以外は review 本文へ回す（1 件でも diff 外の行が
 *   あると GitHub は review 全体を 422 で拒否するため）
 * - issue comment（`Result: completed|failed`）。validation-gate を再評価させる
 *
 * 対象 commit はモデルの申告ではなく workflow の入力（`--sha`）で決める。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGh } from '../lib/gh.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { CLAUDE_REVIEW_MARKER } from '../lib/review-policy.mjs';

const SHA = /^[a-f0-9]{40}$/;
const SEVERITIES = new Set(['P1', 'P2']);
const MAX_FINDINGS = 20;
const MAX_TEXT = 4000;
/** trace.mjs / jev-shadow-truth.ts の P1 / P2 集計が読む badge 表記。 */
const BADGE = {
  P1: '![P1 Badge](https://img.shields.io/badge/P1-red?style=flat)',
  P2: '![P2 Badge](https://img.shields.io/badge/P2-orange?style=flat)',
};

/**
 * unified diff から、RIGHT 側（新しい版）で inline comment を付けられる行を集める。
 * 追加行と文脈行が対象で、削除行は含まない。
 * @param {string} diff
 * @returns {Map<string, Set<number>>}
 */
export function parseCommentableLines(diff) {
  const lines = new Map();
  let current = null;
  let right = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      right = 0;
      continue;
    }
    if (right === 0 && raw.startsWith('--- ')) continue;
    if (right === 0 && raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      current = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (current && !lines.has(current)) lines.set(current, new Set());
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      right = Number(hunk[1]);
      continue;
    }
    if (!current || right === 0) continue;
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      lines.get(current).add(right);
      right += 1;
    }
  }
  return lines;
}

/** モデル出力の本文を投稿用に整える。mention で第三者へ通知を飛ばさず、marker を偽造させない。 */
export function sanitizeText(value) {
  return String(value ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replaceAll('<!--', '')
    .replace(/@(?=[A-Za-z0-9-])/g, '@​')
    .slice(0, MAX_TEXT)
    .trim();
}

/**
 * structured output を検証して findings に正規化する。形が壊れていれば null（= 失敗扱い）。
 * @param {unknown} output
 */
export function normalizeFindings(output) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.findings)) return null;
  const findings = [];
  for (const entry of output.findings.slice(0, MAX_FINDINGS)) {
    if (!entry || typeof entry !== 'object') return null;
    const severity = String(entry.severity ?? '').toUpperCase();
    if (!SEVERITIES.has(severity)) return null;
    const line = Number(entry.line);
    findings.push({
      severity,
      path: String(entry.path ?? '').replace(/^\.?\//, ''),
      line: Number.isInteger(line) && line > 0 ? line : null,
      title: sanitizeText(entry.title),
      body: sanitizeText(entry.body),
    });
  }
  return { findings, summary: sanitizeText(output.summary) };
}

const findingText = (finding) =>
  `${BADGE[finding.severity]} **${finding.title || finding.severity}**\n\n${finding.body}`;

/**
 * PR review の payload を組み立てる。diff 外の指摘は本文へ回す。
 * @param {{ findings: NonNullable<ReturnType<typeof normalizeFindings>>, sha: string, commentable: Map<string, Set<number>> }} input
 */
export function buildReviewPayload({ findings, sha, commentable }) {
  const inline = [];
  const outside = [];
  for (const finding of findings.findings) {
    if (finding.line !== null && commentable.get(finding.path)?.has(finding.line)) {
      inline.push({
        path: finding.path,
        line: finding.line,
        side: 'RIGHT',
        body: `${CLAUDE_REVIEW_MARKER}\n${findingText(finding)}`,
      });
    } else {
      outside.push(finding);
    }
  }
  const lines = [
    CLAUDE_REVIEW_MARKER,
    '### Claude Review',
    '',
    `**Reviewed commit:** \`${sha}\``,
    '',
    findings.findings.length === 0 ? '指摘なし。' : `指摘 ${findings.findings.length} 件。`,
  ];
  if (findings.summary) lines.push('', findings.summary);
  if (outside.length) {
    lines.push('', '#### diff 外の行への指摘');
    for (const finding of outside) {
      const where = finding.path
        ? ` (\`${finding.path}${finding.line ? `:${finding.line}` : ''}\`)`
        : '';
      lines.push('', `${findingText(finding)}${where}`);
    }
  }
  return { commit_id: sha, event: 'COMMENT', body: lines.join('\n'), comments: inline };
}

/**
 * validation-gate を再評価させる結果 comment。
 * @param {{ sha: string, result: 'completed' | 'failed', findings?: number, reviewUrl?: string, runUrl?: string, reason?: string }} input
 */
export function buildResultComment({ sha, result, findings, reviewUrl, runUrl, reason }) {
  const lines = [CLAUDE_REVIEW_MARKER, `**Reviewed commit:** \`${sha}\``, `Result: ${result}`];
  if (result === 'completed') lines.push(`Findings: ${findings ?? 0}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (reviewUrl) lines.push(`Review: ${reviewUrl}`);
  if (runUrl) lines.push(`Run: ${runUrl}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!key || argv[i + 1] === undefined) throw new Error(`invalid argument: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  return args;
}

function postJson(path, payload, gh) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-review-'));
  const file = join(dir, 'payload.json');
  writeFileSync(file, JSON.stringify(payload));
  return JSON.parse(gh(['api', '--method', 'POST', path, '--input', file]));
}

/**
 * @param {{ argv: string[], env: Record<string, string | undefined>,
 *   gh?: (args: string[]) => string }} deps
 */
export function run({ argv, env, gh = (args) => runGh(args) }) {
  const args = parseArgs(argv);
  const repo = env.GITHUB_REPOSITORY;
  const pr = Number(args.pr);
  const sha = String(args.sha ?? '').toLowerCase();
  const base = String(args.base ?? '').toLowerCase();
  if (!repo || !Number.isInteger(pr) || pr <= 0 || !SHA.test(sha) || !SHA.test(base))
    throw new Error('--pr, --sha, --base and GITHUB_REPOSITORY are required');
  const comment = (body) => postJson(`repos/${repo}/issues/${pr}/comments`, { body }, gh);
  const fail = (reason) => {
    comment(buildResultComment({ sha, result: 'failed', runUrl: args['run-url'], reason }));
    return { result: 'failed', reason };
  };
  if (args.outcome !== 'success') return fail(`review step outcome: ${args.outcome ?? 'unknown'}`);

  // モデル出力は shell の引数へ展開しない（workflow から env で受け取る）。
  let parsed;
  try {
    parsed = JSON.parse(env.CLAUDE_REVIEW_OUTPUT ?? '');
  } catch {
    return fail('structured output is missing or not JSON');
  }
  const findings = normalizeFindings(parsed);
  if (!findings) return fail('structured output does not match the findings schema');

  // PR の現 diff ではなく、review した head の diff で行を判定する（review 中に push されても
  // commit_id と inline の行がずれない）。
  const diff = gh([
    'api',
    `repos/${repo}/compare/${base}...${sha}`,
    '-H',
    'Accept: application/vnd.github.diff',
  ]);
  let payload = buildReviewPayload({ findings, sha, commentable: parseCommentableLines(diff) });
  let review;
  try {
    review = postJson(`repos/${repo}/pulls/${pr}/reviews`, payload, gh);
  } catch {
    // diff 解析と GitHub の行判定が食い違うと review 全体が 422 になる。inline を諦めて本文へ回す。
    payload = buildReviewPayload({ findings, sha, commentable: new Map() });
    review = postJson(`repos/${repo}/pulls/${pr}/reviews`, payload, gh);
  }
  comment(
    buildResultComment({
      sha,
      result: 'completed',
      findings: findings.findings.length,
      reviewUrl: review.html_url,
      runUrl: args['run-url'],
    }),
  );
  return {
    result: 'completed',
    findings: findings.findings.length,
    inline: payload.comments.length,
  };
}

if (isDirectExecution(import.meta.url)) {
  const outcome = run({ argv: process.argv.slice(2), env: process.env });
  console.log(JSON.stringify(outcome));
}
