#!/usr/bin/env node
/**
 * Playwright の JSON report から retry-pass（初回失敗 → retry で成功）を拾い、
 * 「最終的に緑」と「初回から緑」を分けて見せる（#2743 P1-4）。
 *
 * promote.yml の層 3（product E2E / web E2E）の直後に `if: always()` で呼ぶ。
 *
 * - Step Summary に件数表と retry-pass 一覧を書く
 * - retry-pass ごとに `::warning file=…,line=…` 注釈を出す（run の Annotations に並ぶ）
 * - `GITHUB_OUTPUT` に `flaky_count` / `failed_count` を出す（将来の自動起票の足場）
 *
 * **retry-pass では落とさない。** `retries: 2` は一時的障害への復旧手段で、
 * retry-pass を失敗に数えると network 起因の揺れで promote が止まる。代わりに
 * 見えなくしないことを保証する（方針の正本は docs/engineering/testing.md §retry）。
 *
 * fail-closed にする例外は 2 つだけ。どちらも「retry-pass が永久に見えなくなる」経路:
 * - test step が success なのに JSON が無い（reporter 設定が消えた）
 * - JSON が壊れていて読めない
 * test step 自体が失敗・cancel して JSON が無い時は、job は既に赤なので notice に留める。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ERROR_EXCERPT_LENGTH = 200;
const ANSI_ESCAPE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/**
 * @typedef {{ title: string, projectName: string, file: string, line: number,
 *   attempts: number, passedOn: number, firstError: string }} ReportedTest
 * @typedef {{ firstPass: ReportedTest[], retryPassed: ReportedTest[],
 *   failed: ReportedTest[], skipped: ReportedTest[] }} Classified
 */

function firstLine(message) {
  if (typeof message !== 'string') return '';
  // ANSI の色コードは Step Summary では読めないので落とす
  const plain = message.replace(ANSI_ESCAPE, '');
  const line = plain.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > ERROR_EXCERPT_LENGTH ? `${line.slice(0, ERROR_EXCERPT_LENGTH)}…` : line;
}

function toReported(spec, test, titlePath) {
  const results = Array.isArray(test.results) ? test.results : [];
  const passedIndex = results.findIndex((r) => r.status === 'passed');
  const firstFailure = results.find((r) => r.status !== 'passed' && r.status !== 'skipped');
  return {
    title: [...titlePath, spec.title].filter(Boolean).join(' › '),
    projectName: test.projectName ?? '',
    file: spec.file ?? '',
    line: typeof spec.line === 'number' ? spec.line : 0,
    attempts: results.length,
    passedOn: passedIndex + 1,
    firstError: firstLine(firstFailure?.error?.message ?? firstFailure?.errors?.[0]?.message),
  };
}

/**
 * 分類は `test.status` だけで行う。`expectedStatus`（test.fail() 等）の解釈は
 * Playwright が済ませているので、results から再計算しない。
 *
 * @param {unknown} report
 * @returns {Classified}
 */
export function classifyReport(report) {
  /** @type {Classified} */
  const classified = { firstPass: [], retryPassed: [], failed: [], skipped: [] };
  if (!report || typeof report !== 'object' || !Array.isArray(report.suites)) {
    throw new Error('Playwright JSON report の形ではありません（suites 配列が無い）');
  }

  const walk = (suite, titlePath) => {
    // file suite の title はファイル名なので title path には含めない
    const nextPath =
      suite.title && suite.title !== suite.file ? [...titlePath, suite.title] : titlePath;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const reported = toReported(spec, test, nextPath);
        if (test.status === 'flaky') classified.retryPassed.push(reported);
        else if (test.status === 'unexpected') classified.failed.push(reported);
        else if (test.status === 'skipped') classified.skipped.push(reported);
        else classified.firstPass.push(reported);
      }
    }
    for (const child of suite.suites ?? []) walk(child, nextPath);
  };

  for (const suite of report.suites) walk(suite, []);
  return classified;
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * @param {Classified} classified
 * @param {{ label: string }} options
 */
export function renderSummary(classified, { label }) {
  const { firstPass, retryPassed, failed, skipped } = classified;
  const lines = [
    `## E2E retry report (${label})`,
    '',
    '| first-pass | retry-pass | failed | skipped |',
    '| ---: | ---: | ---: | ---: |',
    `| ${firstPass.length} | ${retryPassed.length} | ${failed.length} | ${skipped.length} |`,
    '',
  ];

  if (retryPassed.length > 0) {
    lines.push(
      '### Retry-passed',
      '',
      '最終的には緑だが初回は失敗した test。同じ test が続けて出たら flaky として issue 化する（docs/engineering/testing.md §retry）。',
      '',
      '| project | test | passed on | first error |',
      '| --- | --- | --- | --- |',
      ...retryPassed.map(
        (t) =>
          `| ${escapeCell(t.projectName)} | ${escapeCell(t.title)} (\`${escapeCell(t.file)}:${t.line}\`) | ${t.passedOn}/${t.attempts} | ${escapeCell(t.firstError)} |`,
      ),
      '',
    );
  } else {
    lines.push('retry で救済された test はありません。', '');
  }

  if (failed.length > 0) {
    lines.push(
      '### Failed',
      '',
      ...failed.map((t) => `- ${t.projectName} › ${t.title} (\`${t.file}:${t.line}\`)`),
      '',
    );
  }
  return lines.join('\n');
}

/**
 * @param {Classified} classified
 * @param {{ filePrefix: string }} options
 */
export function renderAnnotations(classified, { filePrefix }) {
  return classified.retryPassed.map((t) => {
    const message = `${t.projectName} › ${t.title} passed on attempt ${t.passedOn} of ${t.attempts}`;
    // workflow command の property 値では % , : と改行を escape する
    const file = `${filePrefix}${t.file}`
      .replace(/%/g, '%25')
      .replace(/,/g, '%2C')
      .replace(/:/g, '%3A');
    const body = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    return `::warning file=${file},line=${t.line},title=E2E retry-pass::${body}`;
  });
}

/**
 * @param {{ jsonPresent: boolean, parsed: boolean, testOutcome: string | undefined }} state
 * @returns {{ exitCode: 0 | 1, message: string | null }}
 */
export function resolveExitCode({ jsonPresent, parsed, testOutcome }) {
  if (!jsonPresent) {
    if (testOutcome === 'success') {
      return {
        exitCode: 1,
        message:
          '::error::E2E は success なのに JSON report がありません。playwright.config の json reporter が外れると retry-pass が見えなくなります。',
      };
    }
    return {
      exitCode: 0,
      message: `::notice::JSON report がありません（E2E step outcome: ${testOutcome ?? 'unknown'}）。job の失敗理由は E2E step を確認してください。`,
    };
  }
  if (!parsed) {
    return {
      exitCode: 1,
      message: '::error::E2E の JSON report を読めませんでした（壊れた JSON）。',
    };
  }
  return { exitCode: 0, message: null };
}

function parseArgs(argv) {
  const [jsonPath, ...rest] = argv;
  const options = { jsonPath, label: 'e2e', filePrefix: '' };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--label') options.label = rest[++i] ?? options.label;
    else if (rest[i] === '--file-prefix') options.filePrefix = rest[++i] ?? '';
  }
  return options;
}

function main() {
  const { jsonPath, label, filePrefix } = parseArgs(process.argv.slice(2));
  if (!jsonPath) {
    console.error(
      'Usage: node scripts/ci/e2e-retry-report.mjs <report.json> [--label <name>] [--file-prefix <dir/>]',
    );
    return 1;
  }
  const testOutcome = process.env.E2E_TEST_OUTCOME;
  const jsonPresent = existsSync(jsonPath);

  let report = null;
  let parsed = false;
  if (jsonPresent) {
    try {
      report = JSON.parse(readFileSync(jsonPath, 'utf8'));
      parsed = true;
    } catch {
      parsed = false;
    }
  }

  const { exitCode, message } = resolveExitCode({ jsonPresent, parsed, testOutcome });
  if (message) console.log(message);
  if (!jsonPresent || !parsed) return exitCode;

  let classified;
  try {
    classified = classifyReport(report);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const summary = renderSummary(classified, { label });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } else {
    console.log(summary);
  }

  for (const annotation of renderAnnotations(classified, { filePrefix })) console.log(annotation);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `flaky_count=${classified.retryPassed.length}\nfailed_count=${classified.failed.length}\n`,
    );
  }
  return exitCode;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  process.exitCode = main();
}
