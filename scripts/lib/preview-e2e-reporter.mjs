import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const FILES = new Set(['critical-path.spec.ts', 'mobile-critical-path.spec.ts']);
const PROJECTS = new Set(['chromium', 'Mobile Chrome']);
const CATEGORIES = new Set(['expect', 'pw:api', 'test.step', 'fixture', 'hook']);

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
  return (
    report?.status === 'passed' &&
    Number.isSafeInteger(report.expected) &&
    report.expected > 0 &&
    Array.isArray(report.tests) &&
    report.tests.length === report.expected &&
    report.tests.every(
      (test) =>
        test &&
        test.status === 'passed' &&
        test.expectedPassed === true &&
        test.retry === 0 &&
        PROJECTS.has(test.project) &&
        FILES.has(test.file),
    ) &&
    [...PROJECTS].every((project) => report.tests.some((test) => test.project === project))
  );
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
    if (!FILES.has(file) || !PROJECTS.has(project)) this.infrastructureFailure = true;
    const screenshots = [];
    let network = null;
    for (const attachment of result.attachments) {
      if (attachment.name === 'preview-network' && attachment.body) {
        network = safePreviewNetwork(attachment.body);
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
    this.tests.push({
      file: FILES.has(file) ? file : null,
      project: PROJECTS.has(project) ? project : null,
      line: test.location.line,
      status: ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status)
        ? result.status
        : 'unknown',
      expectedPassed: test.expectedStatus === 'passed',
      duration: result.duration,
      retry: result.retry,
      steps: this.steps.get(test.id) ?? [],
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
