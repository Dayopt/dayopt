/** Isolated API contract fault experiment. Never modifies the working source tree. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyMutation,
  classifyMutationRun,
  isSuccessfulMutationRun,
  summarizeMutationRun,
} from '../lib/mutation-evidence.mjs';

const root = process.cwd();
const output = path.resolve(process.argv[2] ?? 'artifacts/test-mission/api-mutations');
const roots = ['apps/product/src/features/activities/server'];
const definitions = [
  [
    'owner-list',
    'features/activities/server/activities-query-service.ts',
    ".eq('user_id', options.userId)",
    ".eq('user_id', '10000000-0000-4000-8000-000000000002')",
  ],
  [
    'owner-mutation',
    'features/activities/server/activities-mutation-service.ts',
    ".eq('user_id', userId)",
    ".eq('user_id', '10000000-0000-4000-8000-000000000002')",
  ],
  [
    'owner-delete',
    'features/activities/server/activities-delete-service.ts',
    ".eq('user_id', userId)",
    ".eq('user_id', '10000000-0000-4000-8000-000000000002')",
  ],
  ['auth', 'lib/trpc/procedures.ts', 'if (!ctx.userId)', 'if (false)'],
  [
    'mfa',
    'lib/trpc/procedures.ts',
    "mfaAssurance.nextLevel === 'aal2'",
    "mfaAssurance.nextLevel === 'aal1'",
  ],
  ['oauth', 'lib/trpc/procedures.ts', "if (ctx.authMode === 'oauth')", 'if (false)'],
  ['billing', 'lib/trpc/procedures.ts', 'if (!billingAccess.canUseProduct)', 'if (false)'],
  [
    'fence',
    'lib/trpc/procedures.ts',
    "type === 'mutation' && (await isWriteFenceEnabled(ctx.supabase))",
    'false && (await isWriteFenceEnabled(ctx.supabase))',
  ],
  [
    'archive-visibility',
    'features/activities/server/activities-query-service.ts',
    'if (!options.includeArchived)',
    'if (options.includeArchived)',
  ],
  [
    'trim-name',
    'features/activities/server/activities-mutation-service.ts',
    'const trimmed = name.trim();',
    'const trimmed = name;',
  ],
  [
    'archived-assignment',
    'features/activities/server/activities-mutation-service.ts',
    'if (category.archived_at)',
    'if (false)',
  ],
  [
    'name-limit',
    'features/activities/server/router.ts',
    'const NAME = z.string().min(1).max(50);',
    'const NAME = z.string().min(1).max(500);',
  ],
  [
    'name-upper-bound',
    'features/activities/server/router.ts',
    'const NAME = z.string().min(1).max(50);',
    'const NAME = z.string().min(1).max(49);',
  ],
];
// These are explicit contract faults, not an additional random sample.
const selected = definitions.map(([name, relative, before, after]) => {
  const file = `apps/product/src/${relative}`;
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(before);
  if (start < 0) throw new Error(`Missing mutation anchor: ${name}`);
  return {
    name,
    file,
    start,
    end: start + before.length,
    before,
    after,
    line: source.slice(0, start).split('\n').length,
    sha256: createHash('sha256').update(source).digest('hex'),
  };
});
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(output, 'selection.json'),
  JSON.stringify({ kind: 'explicit-api-contract-faults', roots, selected }, null, 2) + '\n',
);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dayopt-mutations-'));
const report = {
  kind: 'explicit-api-contract-faults',
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
        include: ['apps/product/src/features/activities/server/router.test.ts'],

        maxWorkers: 2,
        testTimeout: 10000,
        setupFiles: [path.join(scratch, 'apps/product/src/lib/test/setup-node.ts')],
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
        `${index + 1}/${selected.length} ${status}: ${mutant.file}:${mutant.line} ${mutant.before} -> ${mutant.after}`,
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
  report.results.length !== selected.length ||
  report.results.some((r) => r.status !== 'killed')
) {
  process.exitCode = 1;
}
