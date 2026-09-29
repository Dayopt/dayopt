/** Isolated, seeded mutation experiment. Never modifies the working source tree. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const output = path.resolve(process.argv[2] ?? 'artifacts/test-mission/mutations');
const seed = Number(process.argv[3] ?? 20260929);
const roots = [
  'apps/product/src/lib/time',
  'apps/product/src/features/timeblock/domain',
  'apps/product/src/features/calendar/domain',
  'packages/billing/src',
];
const files = spawnSync('git', ['ls-files', ...roots], { encoding: 'utf8' })
  .stdout.trim()
  .split('\n');
const replacements = new Map([
  ['>', '>='],
  ['>=', '>'],
  ['<', '<='],
  ['<=', '<'],
  ['===', '!=='],
  ['!==', '==='],
  ['&&', '||'],
  ['||', '&&'],
  ['+', '-'],
  ['-', '+'],
  ['*', '/'],
  ['/', '*'],
]);
const candidates = [];
for (const file of files.filter(
  (f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$|test-helpers/.test(f),
)) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      const before = token.getText(ast);
      if (replacements.has(before)) {
        const start = token.getStart(ast);
        candidates.push({
          file,
          start,
          end: token.end,
          line: ast.getLineAndCharacterOfPosition(start).line + 1,
          before,
          after: replacements.get(before),
          expression: node.getText(ast),
          sha256: createHash('sha256').update(source).digest('hex'),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
// Fisher-Yates with a recorded PRNG seed; selection is frozen before any tests run.
let state = seed >>> 0;
function random() {
  state = (Math.imul(1664525, state) + 1013904223) >>> 0;
  return state / 4294967296;
}
for (let i = candidates.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
}
const selected = candidates.slice(0, 20);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(output, 'selection.json'),
  JSON.stringify({ seed, roots, candidateCount: candidates.length, selected }, null, 2) + '\n',
);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dayopt-mutations-'));
const report = {
  seed,
  candidateCount: candidates.length,
  head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  baseline: null,
  results: [],
  restored: false,
};
try {
  for (const dir of ['apps/product/src', 'packages/billing/src']) {
    fs.cpSync(path.join(root, dir), path.join(scratch, dir), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  fs.symlinkSync(
    path.join(root, 'apps/product/node_modules'),
    path.join(scratch, 'apps/product/node_modules'),
    'dir',
  );
  fs.symlinkSync(
    path.join(root, 'packages/billing/node_modules'),
    path.join(scratch, 'packages/billing/node_modules'),
    'dir',
  );
  const config = path.join(scratch, 'vitest.config.mjs');
  fs.writeFileSync(
    config,
    `export default ${JSON.stringify({
      root: scratch,
      resolve: { alias: { '@': path.join(scratch, 'apps/product/src') } },
      test: {
        environment: 'node',
        include: roots.map((dir) => `${dir}/**/*.test.ts`),
        exclude: ['**/calendar-query-input.test.ts'],
        maxWorkers: 2,
        testTimeout: 10000,
        setupFiles: [],
      },
    })};\n`,
  );
  function run(name) {
    const json = path.join(output, `${name}.json`);
    // A failed launch must never reuse a JSON result from an earlier invocation.
    fs.rmSync(json, { force: true });
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
        '--reporter=json',
        '--outputFile',
        json,
      ],
      {
        cwd: scratch,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, TZ: 'UTC' },
      },
    );
    fs.writeFileSync(
      path.join(output, `${name}.log`),
      (result.stdout ?? '') + (result.stderr ?? ''),
    );
    const parsed = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null;
    const failures =
      parsed?.testResults?.flatMap((suite) =>
        suite.assertionResults
          .filter((test) => test.status === 'failed')
          .map((test) => ({ name: test.fullName, messages: test.failureMessages })),
      ) ?? [];
    return {
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
      passed: parsed?.numPassedTests ?? 0,
      failed: parsed?.numFailedTests ?? 0,
      pending: parsed?.numPendingTests ?? 0,
      runtimeErrors: parsed?.numRuntimeErrorTestSuites ?? 0,
      failures,
    };
  }
  report.baseline = run('baseline');
  if (
    report.baseline.exitCode !== 0 ||
    report.baseline.passed === 0 ||
    report.baseline.pending !== 0
  )
    throw new Error('Baseline is not clean; no mutant can count as killed.');
  for (const [index, mutant] of selected.entries()) {
    const target = path.join(scratch, mutant.file);
    const original = fs.readFileSync(target, 'utf8');
    try {
      fs.writeFileSync(
        target,
        original.slice(0, mutant.start) + mutant.after + original.slice(mutant.end),
      );
      const result = run(`mutant-${String(index + 1).padStart(2, '0')}`);
      // A collection/import/timeout error alone is never a kill.
      const complete =
        !result.signal &&
        !result.error &&
        result.pending === 0 &&
        result.runtimeErrors === 0 &&
        result.passed + result.failed === report.baseline.passed;
      const status = !complete
        ? 'inconclusive'
        : result.exitCode === 0
          ? 'survived'
          : result.failed > 0 &&
              result.failures.some((f) =>
                f.messages.some((m) => /AssertionError|expected .*|to (?:be|equal|throw)/s.test(m)),
              )
            ? 'killed'
            : 'inconclusive';
      report.results.push({ ...mutant, ...result, status });
      console.log(
        `${index + 1}/20 ${status}: ${mutant.file}:${mutant.line} ${mutant.before} -> ${mutant.after}`,
      );
    } finally {
      fs.writeFileSync(target, original);
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  report.restoration = run('restored');
  report.restored =
    report.restoration.exitCode === 0 && report.restoration.passed === report.baseline.passed;
} finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (!report.restored || report.results.some((r) => r.status !== 'killed')) process.exitCode = 1;
