import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const FILES = new Set(['critical-path.spec.ts', 'mobile-critical-path.spec.ts']);
const PROJECTS = new Set(['chromium', 'Mobile Chrome']);
// Reviewed browser acceptance scope. Changes require a reviewed trusted harness rollout.
const COVERAGE = [
  {
    file: 'critical-path.spec.ts',
    project: 'chromium',
    flowIds: [
      'desktop-plan-create',
      'desktop-record-create',
      'desktop-past-plan-create',
      'desktop-summary-known-records',
      'desktop-summary-record-deep-link',
      'desktop-summary-empty',
      'desktop-settings-display',
      'desktop-data-export',
      'desktop-activity-lifecycle',
      'desktop-theme',
      'desktop-timezone',
      'desktop-locale',
      'desktop-category-lifecycle',
      'desktop-inspector-search',
      'desktop-plan-move',
      'desktop-conflict-merge',
      'desktop-template-lifecycle',
    ],
  },
  {
    file: 'mobile-critical-path.spec.ts',
    project: 'Mobile Chrome',
    flowIds: [
      'mobile-plan-create',
      'mobile-record-create',
      'mobile-summary-to-inspector',
      'mobile-settings-display',
    ],
  },
];
const EXPECTED_FLOWS = new Map(
  COVERAGE.flatMap((row) => row.flowIds.map((flowId) => [flowId, row])),
);
const EXPECTED_COUNT = EXPECTED_FLOWS.size;
const PREVIEW_FLOW_TAG_PREFIX = 'preview-e2e/';

const CATEGORIES = new Set(['expect', 'pw:api', 'test.step', 'fixture', 'hook']);
const BUDGET_FIELDS = ['procedures', 'budget', 'rateLimitedResponses', 'mixedBatchResponses'];
const MAX_PUBLIC_FAILED_STEPS = 40;
const MAX_PLAYWRIGHT_DURATION_MS = 7 * 60 * 1000;

/** Numeric diagnostics only: discard procedure names and arbitrary candidate fields. */
export function safePreviewProcedureBudget(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !BUDGET_FIELDS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
  )
    return null;
  return Object.fromEntries(BUDGET_FIELDS.map((key) => [key, value[key]]));
}

/** The candidate reporter and trusted publisher reconstruct the same allowlisted failure rows. */
export function safePreviewFailedSteps(test) {
  if (test.status === 'passed' || test.status === 'skipped') return [];
  const steps = Array.isArray(test.steps)
    ? test.steps.filter((step) => step?.failed === true)
    : Array.isArray(test.failedSteps)
      ? test.failedSteps
      : [];
  return steps.slice(0, MAX_PUBLIC_FAILED_STEPS).map((step) => ({
    category: CATEGORIES.has(step?.category) ? step.category : 'other',
    file: FILES.has(step?.file) ? step.file : null,
    line:
      FILES.has(step?.file) && Number.isSafeInteger(step.line) && step.line > 0 ? step.line : null,
    duration:
      Number.isFinite(step?.duration) && step.duration >= 0
        ? Math.min(Math.round(step.duration), MAX_PLAYWRIGHT_DURATION_MS)
        : 0,
  }));
}

/** Do not serialize titles, parameters, error messages, stdout, headers, cookies, or bodies. */
export function safePreviewStep(step) {
  return {
    category: CATEGORIES.has(step.category) ? step.category : 'other',
    file: FILES.has(basename(step.location?.file ?? '')) ? basename(step.location.file) : null,
    line: Number.isSafeInteger(step.location?.line) ? step.location.line : null,
    duration: Number.isFinite(step.duration) ? step.duration : 0,
    failed: Boolean(step.error),
  };
}

export function safePreviewNetwork(buffer) {
  try {
    const rows = JSON.parse(buffer.toString());
    if (!Array.isArray(rows) || rows.length > 2000) return null;
    return rows.map((row) => {
      if (
        !['preview', 'supabase', 'captcha', 'blocked'].includes(row?.target) ||
        !Number.isFinite(row.at) ||
        row.at < 0 ||
        !Number.isInteger(row.status) ||
        row.status < 0 ||
        row.status > 599
      )
        throw new Error();
      return { at: row.at, target: row.target, status: row.status };
    });
  } catch {
    return null;
  }
}

/** Shared by the reporter and runner; exit 0 cannot replace complete evidence. */
export function isPassingPreviewReport(report) {
  if (
    report?.status !== 'passed' ||
    report.expected !== EXPECTED_COUNT ||
    !Array.isArray(report.tests) ||
    report.tests.length !== EXPECTED_COUNT
  )
    return false;
  const declarations = new Set();
  for (const test of report.tests) {
    const expected = EXPECTED_FLOWS.get(test?.flowId);
    if (
      !test ||
      !expected ||
      test.status !== 'passed' ||
      test.expectedPassed !== true ||
      test.retry !== 0 ||
      !Number.isSafeInteger(test.line) ||
      test.line <= 0 ||
      expected.file !== test.file ||
      expected.project !== test.project
    )
      return false;
    if (declarations.has(test.flowId)) return false;
    declarations.add(test.flowId);
  }
  return declarations.size === EXPECTED_COUNT;
}

export default class PreviewE2EReporter {
  constructor(options) {
    this.directory = options.directory;
    this.tests = [];
    this.steps = new Map();
    this.expected = 0;
    this.infrastructureFailure = false;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  onBegin(_config, suite) {
    this.expected = suite.allTests().length;
  }

  onStepEnd(test, _result, step) {
    const steps = this.steps.get(test.id) ?? [];
    if (steps.length < 2000) steps.push(safePreviewStep(step));
    else this.infrastructureFailure = true;
    this.steps.set(test.id, steps);
  }

  onError() {
    this.infrastructureFailure = true;
  }

  onTestEnd(test, result) {
    const file = basename(test.location.file);
    const project = test.parent.project()?.name;
    const flowTags = Array.isArray(test.tags)
      ? test.tags
          .filter((tag) => typeof tag === 'string')
          .map((tag) => tag.replace(/^@/, ''))
          .filter((tag) => tag.startsWith(PREVIEW_FLOW_TAG_PREFIX))
      : [];
    const taggedFlowId =
      flowTags.length === 1 ? flowTags[0].slice(PREVIEW_FLOW_TAG_PREFIX.length) : null;
    const reviewedFlow = taggedFlowId ? EXPECTED_FLOWS.get(taggedFlowId) : null;
    const flowId =
      reviewedFlow?.file === file && reviewedFlow.project === project ? taggedFlowId : null;
    if (!FILES.has(file) || !PROJECTS.has(project)) this.infrastructureFailure = true;
    if (!flowId) this.infrastructureFailure = true;
    const screenshots = [];
    let network = null;
    let procedureBudget = null;
    for (const attachment of result.attachments) {
      if (attachment.name === 'preview-network' && attachment.body) {
        network = safePreviewNetwork(attachment.body);
      }
      if (
        attachment.name === 'trpc-procedure-budget' &&
        attachment.body &&
        attachment.body.length <= 2048
      ) {
        try {
          procedureBudget = safePreviewProcedureBudget(JSON.parse(attachment.body.toString()));
        } catch {
          // Malformed diagnostic data is omitted; never expose parse errors or raw contents.
          procedureBudget = null;
        }
      }
      if (
        attachment.name === 'screenshot' &&
        attachment.contentType === 'image/png' &&
        attachment.path
      ) {
        const data = readFileSync(attachment.path);
        if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          const name = `screenshot-${this.tests.length}-${screenshots.length}.png`;
          copyFileSync(attachment.path, join(this.directory, name));
          screenshots.push(name);
        }
      }
    }
    if (!network?.length) this.infrastructureFailure = true;
    const steps = this.steps.get(test.id) ?? [];
    this.tests.push({
      file: FILES.has(file) ? file : null,
      project: PROJECTS.has(project) ? project : null,
      flowId,
      line: test.location.line,
      status: ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status)
        ? result.status
        : 'unknown',
      expectedPassed: test.expectedStatus === 'passed',
      duration: result.duration,
      retry: result.retry,
      steps,
      failedSteps: safePreviewFailedSteps({ status: result.status, steps }),
      ...(procedureBudget ? { procedureBudget } : {}),
      network,
      screenshots,
    });
  }

  onEnd(result) {
    const passed =
      !this.infrastructureFailure &&
      isPassingPreviewReport({
        status: result.status,
        expected: this.expected,
        tests: this.tests,
      });
    writeFileSync(
      join(this.directory, 'e2e.json'),
      JSON.stringify(
        {
          status: passed ? 'passed' : 'failed',
          expected: this.expected,
          tests: this.tests,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return { status: passed ? 'passed' : 'failed' };
  }
}
