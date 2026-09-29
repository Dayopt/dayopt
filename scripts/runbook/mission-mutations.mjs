/** Isolated, seeded mutation experiment. Never modifies the working source tree. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import {
  applyMutation,
  classifyMutationRun,
  isSuccessfulMutationRun,
  selectMutationCandidates,
  summarizeMutationRun,
} from '../lib/mutation-evidence.mjs';

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
// Freeze the complete sample before running tests; refuse fewer than twenty sites.
const selected = selectMutationCandidates(candidates, seed);
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
    return summarizeMutationRun(parsed, result);
  }
  report.baseline = run('baseline');
  if (!isSuccessfulMutationRun(report.baseline)) {
    throw new Error('Baseline is not clean; no mutant can count as killed.');
  }

  for (const [index, mutant] of selected.entries()) {
    const target = path.join(scratch, mutant.file);
    const original = fs.readFileSync(target, 'utf8');
    try {
      fs.writeFileSync(target, applyMutation(original, mutant));
      const result = run(`mutant-${String(index + 1).padStart(2, '0')}`);
      const status = classifyMutationRun(result, report.baseline);
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
    isSuccessfulMutationRun(report.restoration) &&
    classifyMutationRun(report.restoration, report.baseline) === 'survived';
} finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (
  !report.restored ||
  report.results.length !== 20 ||
  report.results.some((r) => r.status !== 'killed')
) {
  process.exitCode = 1;
}
