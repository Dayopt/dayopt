import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';

/**
 * close 済み issue に残る `Workflow status` の値だけを消す backstop。
 * Issue field DELETE endpoint は指定した field だけを消すため、Priority など
 * 他の field 値・ラベルには触れない。active issue の status は変更しない。
 *
 * 動的な値は execFile の argv 要素として渡し、shell を経由しない。
 */

const REPO = 'Dayopt/dayopt';
const GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const WORKFLOW_STATUS_FIELD_ID = 47507683;
export const WORKFLOW_STATUS_FIELD_SLUG = 'workflow-status';
export const KNOWN_WORKFLOW_STATUSES = ['Ready', 'In Progress', 'Review', 'Blocked', 'Watching'];

/**
 * @typedef {(file: string, args: string[], options?: object) => string} ExecFileImpl
 */

/** @param {string[]} args @param {{ execFileImpl?: ExecFileImpl }} [opts] */
export function runGh(args, { execFileImpl = execFileSync } = {}) {
  return execFileImpl('gh', args, { encoding: 'utf8', maxBuffer: GH_MAX_BUFFER_BYTES });
}

/** @param {string[]} args @param {{ execFileImpl?: ExecFileImpl }} [opts] */
export function runGhJson(args, opts = {}) {
  return JSON.parse(runGh(args, opts));
}

/**
 * close 済みの対象 issue で Workflow status が設定されていれば、その field だけを消す。
 * 呼び出し直前に state と field 値を再読込し、一覧取得後に open へ戻った issue を飛ばす。
 * @param {number} issueNumber
 * @param {{ execFileImpl?: ExecFileImpl }} [opts]
 * @returns {string | null} 消した status。対象外・未設定なら null。
 */
export function clearClosedWorkflowStatusForIssue(issueNumber, { execFileImpl } = {}) {
  const issue = runGhJson(['api', `repos/${REPO}/issues/${issueNumber}`], { execFileImpl });
  if (issue.pull_request || issue.state?.toLowerCase() !== 'closed') return null;

  const fields = runGhJson(['api', `repos/${REPO}/issues/${issueNumber}/issue-field-values`], {
    execFileImpl,
  });
  if (!Array.isArray(fields))
    throw new Error(`#${issueNumber}: Issue field values の応答が配列ではありません`);

  const statusField = fields.find((field) => field.issue_field_id === WORKFLOW_STATUS_FIELD_ID);
  if (!statusField) return null;

  const status = statusField.single_select_option?.name;
  if (!KNOWN_WORKFLOW_STATUSES.includes(status)) {
    throw new Error(
      `#${issueNumber}: 未知の Workflow status を安全のため残します (${status ?? '未取得'})`,
    );
  }

  runGh(
    [
      'api',
      '--method',
      'DELETE',
      `repos/${REPO}/issues/${issueNumber}/issue-field-values/${WORKFLOW_STATUS_FIELD_ID}`,
    ],
    { execFileImpl },
  );
  return status;
}

/**
 * 指定 status を持つ closed issue の番号を全ページ取得する。REST list issues は PR も返すため除外する。
 * @param {string} status
 * @param {{ execFileImpl?: ExecFileImpl }} [opts]
 * @returns {number[]}
 */
export function findClosedIssuesWithWorkflowStatus(status, { execFileImpl } = {}) {
  if (!KNOWN_WORKFLOW_STATUSES.includes(status)) {
    throw new Error(`未知の Workflow status: ${status}`);
  }
  const fieldFilter = encodeURIComponent(`${WORKFLOW_STATUS_FIELD_SLUG}:${status}`);
  const pages = runGhJson(
    [
      'api',
      '--paginate',
      '--slurp',
      `repos/${REPO}/issues?state=closed&per_page=100&issue_field_values=${fieldFilter}`,
    ],
    { execFileImpl },
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('closed issues 検索の応答形式が不正です');
  }
  return pages
    .flat()
    .filter((issue) => !issue.pull_request)
    .map((issue) => issue.number);
}

/**
 * 全選択肢の closed issue を検索し、重複除去して番号順に返す。
 * @param {{ execFileImpl?: ExecFileImpl }} [opts]
 * @returns {{number: number, status: string}[]}
 */
export function collectBulkTargets({ execFileImpl } = {}) {
  const statusesByNumber = new Map();
  for (const status of KNOWN_WORKFLOW_STATUSES) {
    for (const number of findClosedIssuesWithWorkflowStatus(status, { execFileImpl })) {
      const previous = statusesByNumber.get(number);
      if (previous && previous !== status) {
        throw new Error(
          `#${number}: 複数の Workflow status が検索されました (${previous}, ${status})`,
        );
      }
      statusesByNumber.set(number, status);
    }
  }
  return [...statusesByNumber]
    .sort(([numberA], [numberB]) => numberA - numberB)
    .map(([number, status]) => ({ number, status }));
}

/**
 * nightly.yml の timeout-minutes: 10 に対し 2 分の余白を残す。
 */
export const DEFAULT_BULK_BUDGET_SECONDS = 480;

/**
 * 対象 issue を時間予算内で順に処理し、途中経過を返す。
 * @param {{
 *   targets: {number: number, status: string}[],
 *   budgetSeconds?: number,
 *   nowImpl?: () => number,
 *   clearImpl?: (issueNumber: number) => string | null,
 *   logImpl?: (message: string) => void,
 * }} opts
 * @returns {{ processed: number, remaining: number, lastProcessed: number | undefined }}
 */
export function runBulkClear({
  targets,
  budgetSeconds = DEFAULT_BULK_BUDGET_SECONDS,
  nowImpl = Date.now,
  clearImpl = clearClosedWorkflowStatusForIssue,
  logImpl = console.log,
}) {
  const startedAt = nowImpl();
  const budgetMs = budgetSeconds * 1000;
  let processed = 0;
  /** @type {number | undefined} */
  let lastProcessed;

  for (const target of targets) {
    if (nowImpl() - startedAt >= budgetMs) break;
    const cleared = clearImpl(target.number);
    processed += 1;
    lastProcessed = target.number;
    logImpl(
      `[${processed}/${targets.length}] #${target.number}: ${
        cleared ? `Workflow status=${cleared} を解除` : '再確認時点で対象なし'
      }`,
    );
  }

  return { processed, remaining: targets.length - processed, lastProcessed };
}

/** @param {{ processed: number, remaining: number, lastProcessed: number | undefined }} result */
export function formatBulkInterruption({ processed, remaining, lastProcessed }) {
  const resumeCommand =
    lastProcessed === undefined
      ? 'node scripts/ci/clear-closed-workflow-status.mjs bulk --execute'
      : `node scripts/ci/clear-closed-workflow-status.mjs bulk --execute --resume-from ${lastProcessed}`;
  const progress =
    processed === 0
      ? '時間予算内に 1 件も処理できませんでした（1 件あたりの所要時間が予算を超えている可能性があります）。'
      : `時間予算に達したため ${processed} 件で打ち切りました。`;
  return `${progress} 残り ${remaining} 件。続きは次回の sweep が拾いますが、今すぐ流し切る場合:\n\n    ${resumeCommand}\n`;
}

if (isDirectExecution(import.meta.url)) {
  const [subcommand, ...rest] = process.argv.slice(2);
  try {
    if (subcommand === 'on-close') {
      const issueNumber = Number(rest[0]);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(`issue番号が不正です: ${rest[0]}`);
      }
      const cleared = clearClosedWorkflowStatusForIssue(issueNumber);
      console.log(
        cleared
          ? `#${issueNumber}: Workflow status=${cleared} を解除しました`
          : `#${issueNumber}: closed issue の Workflow status は未設定、または対象外です`,
      );
    } else if (subcommand === 'bulk') {
      const dryRun = !rest.includes('--execute');
      const resumeFromArgIndex = rest.indexOf('--resume-from');
      const resumeFrom = resumeFromArgIndex >= 0 ? Number(rest[resumeFromArgIndex + 1]) : undefined;
      if (resumeFromArgIndex >= 0 && (!Number.isInteger(resumeFrom) || resumeFrom <= 0)) {
        throw new Error(`--resume-from の値が不正です: ${rest[resumeFromArgIndex + 1]}`);
      }

      const budgetArgIndex = rest.indexOf('--budget-seconds');
      const budgetSeconds =
        budgetArgIndex >= 0 ? Number(rest[budgetArgIndex + 1]) : DEFAULT_BULK_BUDGET_SECONDS;
      if (budgetArgIndex >= 0 && (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0)) {
        throw new Error(`--budget-seconds の値が不正です: ${rest[budgetArgIndex + 1]}`);
      }

      console.log(
        `対象を検索中（closed issue の Workflow status: ${KNOWN_WORKFLOW_STATUSES.join(', ')}）...`,
      );
      const targets = collectBulkTargets();
      const scoped = resumeFrom ? targets.filter(({ number }) => number > resumeFrom) : targets;
      console.log(
        `対象: ${targets.length} 件${resumeFrom ? `（#${resumeFrom} 以前を除いた残り ${scoped.length} 件から再開）` : ''}`,
      );

      if (dryRun) {
        console.log('--dry-run（既定）: 実際の field 変更は行いません。対象一覧:');
        console.log(
          scoped.map(({ number, status }) => `#${number}: ${status}`).join('\n') || '（対象なし）',
        );
        console.log(
          `dry-run 結果: ${scoped.length} 件が対象。実行するには --execute を付けてください。`,
        );
      } else {
        const result = runBulkClear({ targets: scoped, budgetSeconds });
        if (result.remaining === 0) {
          console.log(`完了: ${result.processed} 件処理しました。`);
        } else {
          const report = formatBulkInterruption(result);
          console.log(report);
          console.log(
            `::warning::Workflow status sweep を打ち切りました（残り ${result.remaining} 件）`,
          );
          const summaryPath = process.env.GITHUB_STEP_SUMMARY;
          if (summaryPath) {
            appendFileSync(summaryPath, `## Workflow status sweep\n\n${report}\n`);
          }
        }
      }
    } else {
      console.error(
        'Usage: node scripts/ci/clear-closed-workflow-status.mjs <on-close <issue番号> | bulk [--execute] [--resume-from <issue番号>] [--budget-seconds <秒>]> ',
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'clear-closed-workflow-status failed');
    process.exitCode = 1;
  }
}
