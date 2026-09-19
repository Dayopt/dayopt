/**
 * Evaluation Pack の汎用 runner（#2827）。case の保存・評価ループ・collect / evaluate /
 * report を pack 非依存に持つ。shadow harness（`scripts/tasks/jev/shadow.ts`）の
 * 評価ループと保存関数をここへ移し、挙動は変えていない。
 *
 * 外部呼び出し（gh / Jev）は引数で注入する。test は fake を渡し、network を使わない。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  evaluateWithJev,
  jevCacheKey,
  type JevAnnotation,
  type JevOptions,
  type JevRequest,
} from './jev-adapter.ts';
import { fetchPrEvidence, type GhApi, type GhGraphql } from './jev-gh-prs.ts';
import {
  buildPackRequest,
  decideCase,
  exceedsPackInputBudget,
  packQuestionSetId,
  type EvaluationPack,
  type PackCase,
  type PackSplit,
} from './jev-pack.ts';

// --- case store --------------------------------------------------------------

export function readCase<C extends { id: string }>(dir: string, id: string): C | null {
  const path = join(dir, 'cases', `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as C;
  } catch {
    return null;
  }
}

export function writeCase<C extends { id: string }>(dir: string, item: C): void {
  mkdirSync(join(dir, 'cases'), { recursive: true });
  writeFileSync(join(dir, 'cases', `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
}

export function listCases<C extends { id: string }>(dir: string): C[] {
  const casesDir = join(dir, 'cases');
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(casesDir, name), 'utf8')) as C];
      } catch {
        return [];
      }
    });
}

export function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- CLI flags -----------------------------------------------------------------

export type SplitFilter = PackSplit | 'all';

export type RunnerFlags = {
  out: string;
  limit: number;
  max: number | null;
  split: SplitFilter;
  delayMs: number;
  rateLimitWaitMs: number;
  /** policy の閾値。pack が使うかは pack 次第。 */
  threshold: number | null;
  asJson: boolean;
};

export const DEFAULT_LIMIT = 100;
export const DEFAULT_DELAY_MS = 60_000;
export const DEFAULT_RATE_LIMIT_WAIT_MS = 300_000;

const VALUE_FLAGS = new Set([
  '--out',
  '--limit',
  '--max',
  '--split',
  '--delay',
  '--rate-limit-wait',
  '--threshold',
]);

/**
 * flag を**完全に**解釈する。未知の flag も余分な positional も usage error にする
 * （smoke.ts と同じ理由: 打ち間違いが黙って課金リクエストへ化けるのを防ぐ）。
 */
export function parseRunnerFlags(
  rest: readonly string[],
  defaults: RunnerFlags,
): { ok: true; flags: RunnerFlags } | { ok: false; message: string } {
  const flags: RunnerFlags = { ...defaults };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--') continue;
    if (token === '--json') {
      flags.asJson = true;
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
      flags.out = value;
      continue;
    }
    if (token === '--split') {
      if (value !== 'tune' && value !== 'holdout' && value !== 'all')
        return { ok: false, message: '--split は tune / holdout / all のいずれか' };
      flags.split = value;
      continue;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
      return { ok: false, message: `${token} は 0 以上の数値で指定する` };
    if (token === '--threshold') {
      if (parsed > 1) return { ok: false, message: '--threshold は 0 以上 1 以下' };
      flags.threshold = parsed;
    } else if (token === '--limit') flags.limit = parsed;
    else if (token === '--max') flags.max = parsed;
    else if (token === '--delay') flags.delayMs = parsed;
    else flags.rateLimitWaitMs = parsed;
  }
  return { ok: true, flags };
}

// --- evaluate loop ------------------------------------------------------------

export type EvaluateLoopCase = { id: string; annotation: JevAnnotation | null };

export type EvaluateLoopOptions<C extends EvaluateLoopCase> = {
  targets: readonly C[];
  requestOf: (item: C) => JevRequest;
  persist: (item: C, annotation: JevAnnotation) => void;
  max: number | null;
  delayMs: number;
  rateLimitWaitMs: number;
  jevOptions?: JevOptions;
  log?: (line: string) => void;
  sleepImpl?: (ms: number) => Promise<void>;
};

/**
 * case を 1 件ずつ順に評価する。並列にしない（バースト約 5 件で 429 になる実測に合わせる）。
 *
 * - 評価済みで cacheKey が同じ case は送らない
 * - 429 は待って**同じ case を**もう一度だけ送る。次へ進むと、残高確認で 429 になった
 *   case が回答なしのまま残り、評価できたのに落ちた case と見分けが付かなくなる
 * - 同じ case で 2 回連続の 429、予算の下限、回復しない失敗（認証・不正 request）で止まる
 */
export async function runEvaluateLoop<C extends EvaluateLoopCase>({
  targets,
  requestOf,
  persist,
  max,
  delayMs,
  rateLimitWaitMs,
  jevOptions = {},
  log = () => {},
  sleepImpl = sleep,
}: EvaluateLoopOptions<C>): Promise<{ sent: number; stopped: boolean }> {
  let sent = 0;
  let stopped = false;
  for (const item of targets) {
    if (max !== null && sent >= max) break;
    const request = requestOf(item);
    if (
      item.annotation?.status === 'evaluated' &&
      item.annotation.cacheKey === jevCacheKey(request)
    ) {
      log(`skip ${item.id}（評価済み・同一入力）`);
      continue;
    }
    if (sent > 0) await sleepImpl(delayMs);

    let annotation = await evaluateWithJev(request, jevOptions);
    if (annotation.reasonCode === 'rate_limited') {
      log(`rate limited: ${item.id} — ${rateLimitWaitMs}ms 待って同じ case を再試行`);
      await sleepImpl(rateLimitWaitMs);
      annotation = await evaluateWithJev(request, jevOptions);
    }
    sent += 1;
    persist(item, annotation);
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
  return { sent, stopped };
}

// --- pack collect / evaluate / report ----------------------------------------

export type AnnotationStats = {
  total: number;
  evaluated: number;
  abstained: number;
  unavailable: number;
  notEvaluated: number;
  /** 評価済みだが、現在の questions / state と cacheKey が一致しない件数。 */
  stale: number;
  costUsd: number;
  latencyMs: { p50: number | null; p95: number | null };
};

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index] ?? null;
}

/** pack を問わない注釈の集計。metrics の本体は pack が持つ。 */
export function computeAnnotationStats<I, T>(
  pack: Pick<EvaluationPack<I, T, unknown>, 'id' | 'questionVersion' | 'questions'>,
  cases: readonly PackCase<I, T>[],
): AnnotationStats {
  const stats: AnnotationStats = {
    total: cases.length,
    evaluated: 0,
    abstained: 0,
    unavailable: 0,
    notEvaluated: 0,
    stale: 0,
    costUsd: 0,
    latencyMs: { p50: null, p95: null },
  };
  const latencies: number[] = [];
  for (const item of cases) {
    const annotation = item.annotation;
    if (!annotation) {
      stats.notEvaluated += 1;
      continue;
    }
    if (annotation.status === 'evaluated') {
      stats.evaluated += 1;
      if (annotation.cacheKey !== jevCacheKey(buildPackRequest(pack, item.state))) stats.stale += 1;
    } else if (annotation.status === 'abstained') stats.abstained += 1;
    else stats.unavailable += 1;
    if (annotation.costUsd !== null) stats.costUsd += annotation.costUsd;
    if (annotation.latencyMs !== null) latencies.push(annotation.latencyMs);
  }
  stats.latencyMs = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) };
  return stats;
}

export function formatAnnotationStats(stats: AnnotationStats): string {
  return [
    `| 項目 | 値 |`,
    `| --- | ---: |`,
    `| 対象 | ${stats.total} |`,
    `| 評価済み | ${stats.evaluated}（stale ${stats.stale}） |`,
    `| abstain | ${stats.abstained} |`,
    `| 利用不可 | ${stats.unavailable} |`,
    `| 未評価 | ${stats.notEvaluated} |`,
    `| 実費 (USD) | ${stats.costUsd} |`,
    `| latency p50 / p95 (ms) | ${stats.latencyMs.p50 ?? '-'} / ${stats.latencyMs.p95 ?? '-'} |`,
  ].join('\n');
}

export async function runPackCollect<I, T, E>({
  pack,
  out,
  limit,
  api,
  graphql,
  now,
  policyCheckout,
  asJson = false,
  legacyOut,
}: {
  pack: EvaluationPack<I, T, E>;
  out: string;
  limit: number;
  api: GhApi;
  graphql: GhGraphql;
  now: () => Date;
  policyCheckout: () => string;
  asJson?: boolean;
  /**
   * 別の保存形式で残っている課金済み注釈の場所（shadow-e1 の `tmp/jev-shadow`）。
   * 同じ id の注釈を初回だけ引き継ぐ。有効性は cacheKey が判定するので、形式が違っても
   * 注釈だけを持ち込んで安全。
   */
  legacyOut?: string;
}): Promise<string> {
  // 取得（gh 呼び出し）と書き戻しの前に、保存先が別 pack のものでないことを確かめる。
  // ここで止めないと、別 pack の case 群へ異物を混ぜたうえで manifest まで上書きし、
  // どちらの pack も evaluate / report が止まる状態になる（手で直すしかなくなる）。
  const mismatch = findPackStoreMismatch(pack, out, listCases<PackCase<I, T>>(out));
  if (mismatch) throw new Error(`${mismatch}。収集せずに止める`);

  const prs = fetchPrEvidence({ api, graphql, limit });
  const stored: PackCase<I, T>[] = [];
  const inheritAnnotation = (id: string): JevAnnotation | null => {
    const previous = readCase<PackCase<I, T>>(out, id);
    if (previous?.annotation) return previous.annotation;
    if (!legacyOut) return null;
    return (
      readCase<{ id: string; annotation?: JevAnnotation | null }>(legacyOut, id)?.annotation ?? null
    );
  };

  for (const candidate of pack.deriveCases(prs)) {
    const truth = pack.truth ? pack.truth(candidate.evidence) : null;
    const { state, dropped } = pack.buildState(candidate.input);
    const item = decideCase(pack, {
      id: candidate.id,
      packId: pack.id,
      split: candidate.split,
      collectionStatus: exceedsPackInputBudget(pack, state) ? 'input_too_large' : 'ready',
      facets: candidate.facets,
      input: candidate.input,
      state,
      droppedSections: dropped,
      truth,
      // 収集し直しても課金済みの注釈を消さない。有効性の判定は evaluate 側の cacheKey 比較が持つ。
      annotation: inheritAnnotation(candidate.id),
      baseline: null,
      decision: null,
    });
    writeCase(out, item);
    stored.push(item);
  }

  for (const synthetic of pack.synthetic ?? []) {
    const item = decideCase(pack, {
      id: synthetic.id,
      packId: pack.id,
      split: 'tune',
      collectionStatus: exceedsPackInputBudget(pack, synthetic.state) ? 'input_too_large' : 'ready',
      facets: { stateSource: 'synthetic' },
      purpose: synthetic.purpose,
      expectation: synthetic.expectation,
      input: null,
      state: synthetic.state,
      droppedSections: [],
      truth: null,
      annotation: inheritAnnotation(synthetic.id),
      baseline: null,
      decision: null,
    });
    writeCase(out, item);
    stored.push(item);
  }

  const counts = {
    total: stored.length,
    ready: stored.filter((item) => item.collectionStatus === 'ready').length,
    inputTooLarge: stored.filter((item) => item.collectionStatus === 'input_too_large').length,
    tune: stored.filter((item) => item.split === 'tune').length,
    holdout: stored.filter((item) => item.split === 'holdout').length,
    withTruth: stored.filter((item) => item.truth !== null).length,
  };
  const manifest = {
    packId: pack.id,
    questionSetId: packQuestionSetId(pack),
    policyVersion: pack.policyVersion,
    fetchedAt: now().toISOString(),
    policyCheckout: policyCheckout(),
    limit,
    counts,
    // 今回の収集で作った case の集合。`--limit` を減らして再収集した時に、前回の
    // 収集だけに含まれていた古い case（issue 本文も正解も更新されていない）が
    // evaluate / report の母集団に残り続けるのを防ぐ。**file は消さない** ──
    // 課金済みの注釈は次の収集で戻ってきた時に再利用するため。
    caseIds: stored.map((item) => item.id),
  };
  writeManifest(out, manifest);

  if (asJson) return JSON.stringify(manifest, null, 2);
  return [
    `収集: ${stored.length} 件 → ${out}（pack ${packQuestionSetId(pack)}）`,
    `policy checkout: ${manifest.policyCheckout}`,
    `ready ${counts.ready} / 入力上限超過 ${counts.inputTooLarge} / tune ${counts.tune} / holdout ${counts.holdout} / 正解あり ${counts.withTruth}`,
  ].join('\n');
}

/**
 * manifest が持つ「今回の収集で作った case」の集合で絞る。manifest が無い・古くて
 * `caseIds` を持たない場合は絞らない（後方互換）。
 */
export function selectActiveCases<I, T>(
  out: string,
  cases: readonly PackCase<I, T>[],
): PackCase<I, T>[] {
  const manifestPath = join(out, 'manifest.json');
  if (!existsSync(manifestPath)) return [...cases];
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { caseIds?: unknown };
    if (!Array.isArray(manifest.caseIds)) return [...cases];
    const active = new Set(manifest.caseIds.filter((id): id is string => typeof id === 'string'));
    if (active.size === 0) return [...cases];
    return cases.filter((item) => active.has(item.id));
  } catch {
    return [...cases];
  }
}

/**
 * 保存先が別 pack のものでないことを、外部呼び出しや書き戻しの前に確かめる。
 * `--out` を取り違えると、別 pack の case を今の質問セットで課金送信したり、input の形が
 * 違う case で `decideCase` が落ちたりする。manifest と全 case の `packId` を見る。
 */
export function findPackStoreMismatch<I, T>(
  pack: Pick<EvaluationPack<I, T, unknown>, 'id'>,
  out: string,
  cases: readonly PackCase<I, T>[],
): string | null {
  const manifestPath = join(out, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { packId?: unknown };
      if (typeof manifest.packId === 'string' && manifest.packId !== pack.id)
        return `保存先 ${out} は pack ${manifest.packId} のもの（今の pack は ${pack.id}）`;
    } catch {
      // manifest が壊れていても case 側の packId で判定する。
    }
  }
  const foreign = cases.filter((item) => item.packId !== pack.id);
  if (foreign.length > 0)
    return `保存先 ${out} に別 pack の case が ${foreign.length} 件ある（例: ${foreign[0]?.id} は ${foreign[0]?.packId}）`;
  return null;
}

export async function runPackEvaluate<I, T>({
  pack,
  out,
  split,
  max,
  delayMs,
  rateLimitWaitMs,
  jevOptions = {},
  log = (line: string) => process.stdout.write(`${line}\n`),
  sleepImpl = sleep,
}: {
  pack: EvaluationPack<I, T, unknown>;
  out: string;
  split: SplitFilter;
  max: number | null;
  delayMs: number;
  rateLimitWaitMs: number;
  jevOptions?: JevOptions;
  log?: (line: string) => void;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<number> {
  const stored = listCases<PackCase<I, T>>(out);
  if (stored.length === 0) {
    log(`case が無い。先に collect を実行する（--out ${out}）`);
    return 1;
  }
  const mismatch = findPackStoreMismatch(pack, out, stored);
  if (mismatch) {
    log(`${mismatch}。送信せずに止める`);
    return 1;
  }
  // 直近の収集に含まれない case は送らない（古い issue 内容のまま課金するのを防ぐ）。
  const all = selectActiveCases(out, stored);
  const targets = all.filter(
    (item) => item.collectionStatus === 'ready' && (split === 'all' || item.split === split),
  );
  const { stopped } = await runEvaluateLoop({
    targets,
    requestOf: (item) => buildPackRequest(pack, item.state),
    persist: (item, annotation) => writeCase(out, decideCase(pack, { ...item, annotation })),
    max,
    delayMs,
    rateLimitWaitMs,
    jevOptions,
    log,
    sleepImpl,
  });
  return stopped ? 1 : 0;
}

/**
 * report は Decision を**計算し直してから**集計する。policy を変えた時に、課金済みの
 * 注釈を再利用して新しい Decision で読めるようにするため。
 */
export function runPackReport<I, T>({
  pack,
  out,
  split,
  asJson = false,
}: {
  pack: EvaluationPack<I, T, unknown>;
  out: string;
  split: SplitFilter;
  asJson?: boolean;
}): string {
  const stored = listCases<PackCase<I, T>>(out);
  const mismatch = findPackStoreMismatch(pack, out, stored);
  if (mismatch) throw new Error(mismatch);
  const all = selectActiveCases(out, stored).map((item) => {
    const decided = decideCase(pack, item);
    if (JSON.stringify(decided) !== JSON.stringify(item)) writeCase(out, decided);
    return decided;
  });
  const filtered = split === 'all' ? all : all.filter((item) => item.split === split);
  const stats = computeAnnotationStats(pack, filtered);
  const report = pack.metrics(filtered);
  if (asJson)
    return JSON.stringify(
      {
        packId: pack.id,
        questionSetId: packQuestionSetId(pack),
        split,
        stats,
        report: report.summary,
      },
      null,
      2,
    );
  return [
    `## ${packQuestionSetId(pack)} の集計（policy ${pack.policyVersion}、split: ${split}）`,
    '',
    formatAnnotationStats(stats),
    '',
    report.markdown,
  ].join('\n');
}
