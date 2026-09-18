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
 * 外部呼び出し（gh / Jev）はこの file に閉じる。判定は `scripts/lib/jev-shadow-*.ts`
 * の純粋関数が持ち、test は network 無しでそちらを直接叩く。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  evaluateWithJev,
  jevCacheKey,
  type JevAnnotation,
  type JevOptions,
} from '../../lib/jev-adapter.ts';
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
  type ShadowPrEvidence,
  type ShadowState,
  type ShadowTimelineItem,
  type ShadowTruth,
} from '../../lib/jev-shadow-truth.ts';

const DEFAULT_OUT = 'tmp/jev-shadow';
const DEFAULT_LIMIT = 100;
const DEFAULT_DELAY_MS = 60_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 300_000;
const PR_PAGE_SIZE = 50;
const MAX_PAGES = 10;
/** `pulls/N/files` は 3,000 件までしか返さない。超えたら path 由来の label を unknown にする。 */
const FILES_CAP = 300;

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

export type ShadowArgs = {
  command: 'collect' | 'evaluate' | 'report';
  out: string;
  limit: number;
  max: number | null;
  split: 'tune' | 'holdout' | 'all';
  delayMs: number;
  rateLimitWaitMs: number;
  asJson: boolean;
};

const VALUE_FLAGS = new Set([
  '--out',
  '--limit',
  '--max',
  '--split',
  '--delay',
  '--rate-limit-wait',
]);

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

  const args: ShadowArgs = {
    command,
    out: DEFAULT_OUT,
    limit: DEFAULT_LIMIT,
    max: null,
    split: command === 'evaluate' ? 'tune' : 'all',
    delayMs: DEFAULT_DELAY_MS,
    rateLimitWaitMs: DEFAULT_RATE_LIMIT_WAIT_MS,
    asJson: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--') continue;
    if (token === '--json') {
      args.asJson = true;
      continue;
    }
    if (!token || !VALUE_FLAGS.has(token)) return { ok: false, message: `未知の引数: ${token}` };

    const raw = rest[index + 1];
    if (raw === undefined || raw.startsWith('-'))
      return { ok: false, message: `${token} に値がない` };
    const value = raw.trim();
    if (value === '') return { ok: false, message: `${token} の値が空` };
    index += 1;

    if (token === '--out') {
      args.out = value;
      continue;
    }
    if (token === '--split') {
      if (value !== 'tune' && value !== 'holdout' && value !== 'all')
        return { ok: false, message: '--split は tune / holdout / all のいずれか' };
      args.split = value;
      continue;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
      return { ok: false, message: `${token} は 0 以上の数値で指定する` };
    if (token === '--limit') args.limit = parsed;
    else if (token === '--max') args.max = parsed;
    else if (token === '--delay') args.delayMs = parsed;
    else args.rateLimitWaitMs = parsed;
  }

  return { ok: true, args };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GhApi = (path: string, paginate?: boolean) => unknown;
export type GhGraphql = (query: string, variables: Record<string, string | number>) => unknown;

function defaultApi(path: string, paginate = false): unknown {
  const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path];
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(raw);
  return paginate && Array.isArray(parsed) ? parsed.flat() : parsed;
}

function defaultGraphql(query: string, variables: Record<string, string | number>): unknown {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables))
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(raw);
}

const PR_QUERY = `query($owner:String!,$name:String!,$size:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:MERGED,baseRefName:"main",first:$size,orderBy:{field:UPDATED_AT,direction:DESC},after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title body createdAt mergedAt changedFiles
        labels(first:30){nodes{name}}
        closingIssuesReferences(first:5){nodes{number title body labels(first:30){nodes{name}}}}
        reviewThreads(first:100){nodes{comments(first:1){nodes{author{login} body}}}}
        timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT,PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT],last:100){
          nodes{
            __typename
            ... on ReadyForReviewEvent{createdAt}
            ... on HeadRefForcePushedEvent{createdAt}
            ... on PullRequestCommit{commit{committedDate}}
          }
        }
      }
    }
  }
}`;

type RawPrNode = {
  number: number;
  title: string;
  body: string | null;
  createdAt: string;
  mergedAt: string | null;
  changedFiles: number;
  labels: { nodes: { name: string }[] };
  closingIssuesReferences: {
    nodes: {
      number: number;
      title: string;
      body: string | null;
      labels: { nodes: { name: string }[] };
    }[];
  };
  reviewThreads: {
    nodes: { comments: { nodes: { author: { login: string } | null; body: string }[] } }[];
  };
  timelineItems: {
    nodes: ({
      __typename: string;
      createdAt?: string;
      commit?: { committedDate: string };
    } | null)[];
  };
};

export function normalizePrNode(
  node: RawPrNode,
  files: ShadowPrEvidence['files'],
  filesComplete: boolean,
): ShadowPrEvidence {
  return {
    number: node.number,
    title: node.title,
    body: node.body ?? '',
    labels: node.labels.nodes.map((label) => label.name),
    createdAt: node.createdAt,
    mergedAt: node.mergedAt,
    changedFiles: node.changedFiles,
    filesComplete,
    files,
    reviewThreads: node.reviewThreads.nodes.map((thread) => {
      const first = thread.comments.nodes[0];
      return { authorLogin: first?.author?.login ?? null, body: first?.body ?? '' };
    }),
    timeline: node.timelineItems.nodes.flatMap((item): ShadowTimelineItem[] => {
      if (!item) return [];
      if (item.__typename === 'ReadyForReviewEvent')
        return [{ type: 'ready_for_review' as const, at: item.createdAt ?? null }];
      if (item.__typename === 'HeadRefForcePushedEvent')
        return [{ type: 'force_push' as const, at: item.createdAt ?? null }];
      if (item.__typename === 'PullRequestCommit')
        return [{ type: 'commit' as const, at: item.commit?.committedDate ?? null }];
      return [];
    }),
    closingIssues: node.closingIssuesReferences.nodes.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: issue.labels.nodes.map((label) => label.name),
    })),
  };
}

export function fetchMergedPrs({
  graphql,
  limit,
  owner = 'Dayopt',
  name = 'dayopt',
}: {
  graphql: GhGraphql;
  limit: number;
  owner?: string;
  name?: string;
}): RawPrNode[] {
  const nodes: RawPrNode[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES && nodes.length < limit; page += 1) {
    const variables: Record<string, string | number> = {
      owner,
      name,
      size: Math.min(PR_PAGE_SIZE, limit - nodes.length),
    };
    if (cursor) variables.cursor = cursor;
    const response = graphql(PR_QUERY, variables) as {
      data?: {
        repository?: {
          pullRequests?: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            nodes: RawPrNode[];
          };
        };
      };
    };
    const connection = response?.data?.repository?.pullRequests;
    if (!connection || connection.nodes.length === 0) break;
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return nodes.slice(0, limit);
}

function readStoredCase(dir: string, id: string): StoredCase | null {
  const path = join(dir, 'cases', `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredCase;
  } catch {
    return null;
  }
}

function writeStoredCase(dir: string, item: StoredCase): void {
  mkdirSync(join(dir, 'cases'), { recursive: true });
  writeFileSync(join(dir, 'cases', `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
}

export function listStoredCases(dir: string): StoredCase[] {
  const casesDir = join(dir, 'cases');
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(casesDir, name), 'utf8')) as StoredCase];
      } catch {
        return [];
      }
    });
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
  const nodes = fetchMergedPrs({ graphql, limit: args.limit });
  const stored: StoredCase[] = [];

  for (const node of nodes) {
    const filesComplete = node.changedFiles <= FILES_CAP;
    const rawFiles = filesComplete
      ? (api(`repos/Dayopt/dayopt/pulls/${node.number}/files?per_page=100`, true) as {
          filename: string;
          previous_filename?: string;
        }[])
      : [];
    const files = (Array.isArray(rawFiles) ? rawFiles : []).map((file) => ({
      filename: file.filename,
      previousFilename: file.previous_filename ?? null,
    }));
    const evidence = normalizePrNode(node, files, filesComplete);
    const truth = deriveTruth(evidence, { resolveGate });
    const { state, droppedSections } = buildShadowState(evidence);
    const tooLarge = exceedsInputBudget(state);
    const id = `pr-${node.number}`;
    const previous = readStoredCase(args.out, id);
    const item: StoredCase = {
      id,
      prNumber: node.number,
      split: resolveSplit(node.number),
      stateSource: state.source,
      collectionStatus: tooLarge ? 'input_too_large' : 'ready',
      droppedSections,
      state,
      truth,
      // 収集し直しても課金済みの注釈を消さない。有効性の判定は evaluate 側の cacheKey 比較が持つ。
      annotation: previous?.annotation ?? null,
    };
    writeStoredCase(args.out, item);
    stored.push(item);
  }

  for (const synthetic of SHADOW_SYNTHETIC_CASES) {
    const previous = readStoredCase(args.out, synthetic.id);
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
    writeStoredCase(args.out, item);
    stored.push(item);
  }

  const coverage = computeCoverage(stored as unknown as ShadowCase[]);
  const manifest = {
    fetchedAt: now().toISOString(),
    policyCheckout: policyCheckout(),
    limit: args.limit,
    coverage,
  };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

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

  let sent = 0;
  let stopped = false;
  for (const item of targets) {
    if (args.max !== null && sent >= args.max) break;
    const request = buildShadowRequest(item.state);
    if (
      item.annotation?.status === 'evaluated' &&
      item.annotation.cacheKey === jevCacheKey(request)
    ) {
      log(`skip ${item.id}（評価済み・同一入力）`);
      continue;
    }
    if (sent > 0) await sleepImpl(args.delayMs);

    // 429 は待って**同じ case を**もう一度だけ送る。次へ進むと、残高確認で 429 になった
    // case が回答なしのまま残り、評価できたのに落ちた case と見分けが付かなくなる。
    let annotation = await evaluateWithJev(request, jevOptions);
    if (annotation.reasonCode === 'rate_limited') {
      log(`rate limited: ${item.id} — ${args.rateLimitWaitMs}ms 待って同じ case を再試行`);
      await sleepImpl(args.rateLimitWaitMs);
      annotation = await evaluateWithJev(request, jevOptions);
    }
    sent += 1;
    writeStoredCase(args.out, { ...item, annotation });
    log(
      `${item.id}: ${annotation.status} / ${annotation.reasonCode}` +
        (annotation.costUsd !== null ? ` / $${annotation.costUsd}` : ''),
    );

    if (annotation.reasonCode === 'rate_limited') {
      log('同じ case で 2 回連続の rate limit。停止する');
      stopped = true;
      break;
    }
    if (annotation.status === 'budget_exhausted') {
      log('予算の下限に達した。停止する（credits は購入しない）');
      stopped = true;
      break;
    }
    if (annotation.reasonCode === 'auth_failed' || annotation.reasonCode === 'invalid_request') {
      log(`回復しない失敗（${annotation.reasonCode}）。停止する`);
      stopped = true;
      break;
    }
  }

  log(`送信 ${sent} 件 / 対象 ${targets.length} 件`);
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
  sections.push(
    '',
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
        api: defaultApi,
        graphql: defaultGraphql,
        resolveGate: gate.resolveProtectedPathGate,
        now: () => new Date(),
        policyCheckout: () =>
          execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      })}\n`,
    );
    return 0;
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
