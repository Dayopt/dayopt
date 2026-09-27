/**
 * Phase 1 shadow 評価の CLI（#2827）。`collect` / `evaluate` / `report` の 3 段。
 *
 *   pnpm jev:shadow collect --limit 100
 *   AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- \
 *     pnpm jev:shadow evaluate --split tune --max 5
 *   pnpm jev:shadow report
 *
 * **運用の担当も review gate も変えない。** Jev の出力を記録して集計するだけで、
 * ここから振り分けや merge 可否へ繋がる経路は作らない。
 *
 * 保存形式（`cases/*.json`）は Phase 1 のまま。既定は共通git directoryのjev/legacy-shadow。
 * 古い保存先は --out tmp/jev-shadow で読める。評価ループ・保存関数・
 * gh 取得は `scripts/lib/jev-pack-runner.ts` / `jev-gh-prs.ts` へ移し、この file は
 * 引数解釈と結線だけを持つ。同じ質問セットを pack として扱う入口は
 * `pnpm jev:pack shadow-e1`（`jev-pack-shadow.ts`）。
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { jevStoreRoot } from '../../lib/jev-send-budget.ts';

import type { JevAnnotation, JevOptions } from '../../lib/jev-adapter.ts';
import {
  defaultGhApi,
  defaultGhGraphql,
  fetchPrEvidence,
  readPolicyCheckout,
  type GhApi,
  type GhGraphql,
} from '../../lib/jev-gh-prs.ts';
import {
  DEFAULT_DELAY_MS,
  DEFAULT_LIMIT,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  listCases,
  parseRunnerFlags,
  readCase,
  runEvaluateLoop,
  sleep,
  writeCase,
  writeManifest,
  type RunnerFlags,
} from '../../lib/jev-pack-runner.ts';
import { assertPackEvaluationAllowed } from '../../lib/jev-pack.ts';
import {
  computeCoverage,
  computeStrata,
  formatCoverage,
  formatMetrics,
  type ShadowCase,
} from '../../lib/jev-shadow-report.ts';
import { SHADOW_SYNTHETIC_CASES } from '../../lib/jev-shadow-synthetic.ts';
import {
  buildShadowRequest,
  buildShadowState,
  deriveTruth,
  exceedsInputBudget,
  resolveSplit,
  type ResolveProtectedGate,
  type ShadowState,
  type ShadowTruth,
} from '../../lib/jev-shadow-truth.ts';

export type { GhApi, GhGraphql };

type StoredCase = {
  id: string;
  prNumber: number | null;
  split: 'tune' | 'holdout';
  stateSource: ShadowState['source'];
  collectionStatus: 'ready' | 'input_too_large';
  purpose?: string;
  expectation?: string;
  droppedSections?: string[];
  state: ShadowState;
  truth: ShadowTruth | null;
  annotation: JevAnnotation | null;
};

export type ShadowArgs = RunnerFlags & { command: 'collect' | 'evaluate' | 'report' };

/**
 * argv を**完全に**解釈する。未知の flag も余分な positional も usage error にする
 * （smoke.ts と同じ理由: 打ち間違いが黙って課金リクエストへ化けるのを防ぐ）。
 */
export function parseShadowArgs(
  argv: readonly string[],
): { ok: true; args: ShadowArgs } | { ok: false; message: string } {
  const [command, ...rest] = argv;
  if (command !== 'collect' && command !== 'evaluate' && command !== 'report')
    return {
      ok: false,
      message: `subcommand は collect / evaluate / report のいずれか（受け取った値: ${command ?? 'なし'}）`,
    };
  const parsed = parseRunnerFlags(rest, {
    out: join(jevStoreRoot(), 'legacy-shadow'),
    limit: DEFAULT_LIMIT,
    max: null,
    split: command === 'evaluate' ? 'tune' : 'all',
    delayMs: DEFAULT_DELAY_MS,
    rateLimitWaitMs: DEFAULT_RATE_LIMIT_WAIT_MS,
    threshold: null,
    asJson: false,
  });
  if (!parsed.ok) return parsed;
  return { ok: true, args: { command, ...parsed.flags } };
}

export function listStoredCases(dir: string): StoredCase[] {
  return listCases<StoredCase>(dir);
}

export async function runCollect({
  args,
  api,
  graphql,
  resolveGate,
  now,
  policyCheckout,
}: {
  args: ShadowArgs;
  api: GhApi;
  graphql: GhGraphql;
  resolveGate: ResolveProtectedGate;
  now: () => Date;
  policyCheckout: () => string;
}): Promise<string> {
  const prs = fetchPrEvidence({ api, graphql, limit: args.limit });
  const stored: StoredCase[] = [];

  for (const evidence of prs) {
    const truth = deriveTruth(evidence, { resolveGate });
    const { state, droppedSections } = buildShadowState(evidence);
    const tooLarge = exceedsInputBudget(state);
    const id = `pr-${evidence.number}`;
    const previous = readCase<StoredCase>(args.out, id);
    const item: StoredCase = {
      id,
      prNumber: evidence.number,
      split: resolveSplit(evidence.number),
      stateSource: state.source,
      collectionStatus: tooLarge ? 'input_too_large' : 'ready',
      droppedSections,
      state,
      truth,
      // 収集し直しても課金済みの注釈を消さない。有効性の判定は evaluate 側の cacheKey 比較が持つ。
      annotation: previous?.annotation ?? null,
    };
    writeCase(args.out, item);
    stored.push(item);
  }

  for (const synthetic of SHADOW_SYNTHETIC_CASES) {
    const previous = readCase<StoredCase>(args.out, synthetic.id);
    const item: StoredCase = {
      id: synthetic.id,
      prNumber: null,
      split: 'tune',
      stateSource: 'synthetic',
      collectionStatus: exceedsInputBudget(synthetic.state) ? 'input_too_large' : 'ready',
      purpose: synthetic.purpose,
      expectation: synthetic.expectation,
      state: synthetic.state,
      truth: null,
      annotation: previous?.annotation ?? null,
    };
    writeCase(args.out, item);
    stored.push(item);
  }

  const coverage = computeCoverage(stored as unknown as ShadowCase[]);
  const manifest = {
    fetchedAt: now().toISOString(),
    policyCheckout: policyCheckout(),
    limit: args.limit,
    coverage,
  };
  writeManifest(args.out, manifest);

  if (args.asJson) return JSON.stringify(manifest, null, 2);
  return [
    `収集: ${stored.length} 件 → ${args.out}`,
    `policy checkout: ${manifest.policyCheckout}（保護対象の判定は現 checkout の定義で遡及的に行う）`,
    '',
    formatCoverage(coverage),
  ].join('\n');
}

export async function runEvaluate({
  args,
  jevOptions = {},
  log = (line: string) => process.stdout.write(`${line}\n`),
  sleepImpl = sleep,
}: {
  args: ShadowArgs;
  jevOptions?: JevOptions;
  log?: (line: string) => void;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<number> {
  const all = listStoredCases(args.out);
  if (all.length === 0) {
    log(`case が無い。先に collect を実行する（--out ${args.out}）`);
    return 1;
  }
  const targets = all.filter(
    (item) =>
      item.collectionStatus === 'ready' && (args.split === 'all' || item.split === args.split),
  );
  const { stopped } = await runEvaluateLoop({
    targets,
    requestOf: (item) => buildShadowRequest(item.state),
    persist: (item, annotation) => writeCase(args.out, { ...item, annotation }),
    max: args.max,
    delayMs: args.delayMs,
    rateLimitWaitMs: args.rateLimitWaitMs,
    jevOptions,
    log,
    sleepImpl,
  });
  return stopped ? 1 : 0;
}

export function runReport({ args }: { args: ShadowArgs }): string {
  const all = listStoredCases(args.out);
  const cases = all as unknown as ShadowCase[];
  const filtered = args.split === 'all' ? cases : cases.filter((item) => item.split === args.split);
  const strata = computeStrata(filtered);
  const coverage = computeCoverage(filtered);
  if (args.asJson) return JSON.stringify({ coverage, strata }, null, 2);

  const sections = [
    '## shadow 評価の集計',
    '',
    formatCoverage(coverage),
    '',
    formatMetrics(strata.overall, '全体'),
  ];
  for (const [split, metrics] of Object.entries(strata.bySplit))
    sections.push('', formatMetrics(metrics, `split: ${split}`));
  for (const [source, metrics] of Object.entries(strata.byStateSource))
    sections.push('', formatMetrics(metrics, `state 由来: ${source}`));
  for (const [bucket, metrics] of Object.entries(strata.byEvidence))
    sections.push('', formatMetrics(metrics, bucket));
  sections.push(
    '',
    '注記: Go 条件（過少振り分けゼロ）は `evidenceSufficiency >= 0.5` の層で読む。証拠が無い state に対して',
    'lane の argmax を採ると、Jev が confidence 0.02 で「判断材料が無い」と申告した case まで振り分けてしまう',
    '（2026-09-18 の tune 実測で、過少振り分け 2 件はどちらも本文が空の case だった）。',
    '注記: `localized` の正解は変更 file の領域数で導いているため、翻訳ファイルや隣接 test を含む変更は非局所側に寄る。',
    '注記: 保護対象の判定は現 checkout の定義で遡及的に行っている。',
    '注記: PR 由来 state は `## Review focus` / `## 検証` と見出しなしの本文を落としているが、`## 作業計画` の',
    'チェックリストに作業中の進捗が追記される場合があり、事後情報を完全には除けない（2026-09-18 の実測で',
    '直近 100 PR 中 1 件）。issue 由来と PR 由来を層別して読む。',
  );
  return sections.join('\n');
}

export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseShadowArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(
      `${parsed.message}\n使い方: pnpm jev:shadow <collect|evaluate|report> [--out dir] [--limit N] [--max N] [--split tune|holdout|all] [--delay ms] [--rate-limit-wait ms] [--json]\n`,
    );
    return 1;
  }
  const args = parsed.args;

  if (args.command === 'report') {
    process.stdout.write(`${runReport({ args })}\n`);
    return 0;
  }

  if (args.command === 'collect') {
    // `protected-path-gate.mjs` は top-level await を持つ。tsx が CJS へ落とす .ts からは
    // 静的 import できない（ERR_REQUIRE_ASYNC_MODULE）ので、ここで動的に読む。
    const gate = (await import('../../ci/protected-path-gate.mjs')) as {
      resolveProtectedPathGate: ResolveProtectedGate;
    };
    process.stdout.write(
      `${await runCollect({
        args,
        api: defaultGhApi,
        graphql: defaultGhGraphql,
        resolveGate: gate.resolveProtectedPathGate,
        now: () => new Date(),
        policyCheckout: readPolicyCheckout,
      })}\n`,
    );
    return 0;
  }

  // この CLI が送るのは pack `shadow-e1` と同じ質問セット（`jev:check` が cacheKey の
  // 一致を固定している）。入口が違うだけで無効化を迂回できてはいけないので、
  // `jev:pack` と同じ表を見る。key の確認より先に止めるのも同じ理由。
  const blocked = assertPackEvaluationAllowed('shadow-e1');
  if (blocked) {
    process.stderr.write(blocked);
    return 1;
  }

  if (!process.env.AI_GATEWAY_API_KEY?.trim()) {
    process.stderr.write(
      'AI_GATEWAY_API_KEY が無い。次の形で実行する:\n  AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- pnpm jev:shadow evaluate\n',
    );
    return 1;
  }
  return runEvaluate({ args });
}

/** 直接実行された時だけ走らせる（test が import しただけで実リクエストが飛ぶのを防ぐ）。 */
function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
