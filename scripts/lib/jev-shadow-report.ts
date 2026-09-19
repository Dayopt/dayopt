/**
 * shadow 評価の集計（#2827 Phase 1 の Go 条件）。純粋関数のみ。network を持たない。
 *
 * **単純な正解率で採用しない**（#2827 §8）。過少振り分け・過剰 escalation・abstain 率・
 * confidence 分布・実費を並べて、質問の切り分けが破綻していないかを読む。
 *
 * `lowRiskButProtected` は **gate ではなく率を知るための指標**。Annotation 側では
 * 必須レビューを守れない（schema confinement は形しか保証しない）ので、この数字が
 * ゼロでなくても設計上は想定内。下限は注釈を読まない trusted code が持つ。
 */
import type { JevAnnotation, JevAnswer } from './jev-adapter.ts';
import { SHADOW_REVIEW_QUESTION_IDS } from './jev-shadow-questions.ts';
import type { ShadowStateSource, ShadowTruth } from './jev-shadow-truth.ts';

export type ShadowCase = {
  id: string;
  prNumber: number | null;
  split: 'tune' | 'holdout';
  stateSource: ShadowStateSource;
  collectionStatus: 'ready' | 'input_too_large';
  truth: ShadowTruth | null;
  annotation: JevAnnotation | null;
};

export type ShadowMetrics = {
  total: number;
  evaluated: number;
  abstained: number;
  unavailable: number;
  notEvaluated: number;
  /** 深いレビューが実際に要った変更を routine と答えた件数。目標 0。 */
  underRouting: { count: number; denominator: number; cases: string[] };
  /** 保護対象なのに低リスクと答えた率。gate ではなく観測値。 */
  lowRiskButProtected: { count: number; denominator: number; cases: string[] };
  /** 狭い作業を frontier と答えた件数。 */
  overEscalation: { count: number; denominator: number; cases: string[] };
  agreement: Record<string, { agreed: number; denominator: number }>;
  laneDistribution: Record<string, number>;
  scoreDistribution: Record<string, Record<string, number>>;
  latencyMs: { p50: number | null; p95: number | null };
  costUsd: number;
  confidence: { withConfidence: number; withoutConfidence: number; mean: number | null };
};

function answerOf(annotation: JevAnnotation | null, id: string): JevAnswer | null {
  return annotation?.answers?.[id] ?? null;
}

function laneOf(annotation: JevAnnotation | null): string | null {
  const answer = answerOf(annotation, 'lane');
  return answer && answer.type === 'choice' ? answer.choice : null;
}

function booleanOf(annotation: JevAnnotation | null, id: string): boolean | null {
  const answer = answerOf(annotation, id);
  if (!answer || answer.type !== 'boolean') return null;
  return answer.probability >= 0.5;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index] ?? null;
}

export function computeMetrics(cases: ShadowCase[]): ShadowMetrics {
  const metrics: ShadowMetrics = {
    total: cases.length,
    evaluated: 0,
    abstained: 0,
    unavailable: 0,
    notEvaluated: 0,
    underRouting: { count: 0, denominator: 0, cases: [] },
    lowRiskButProtected: { count: 0, denominator: 0, cases: [] },
    overEscalation: { count: 0, denominator: 0, cases: [] },
    agreement: {},
    laneDistribution: {},
    scoreDistribution: {},
    latencyMs: { p50: null, p95: null },
    costUsd: 0,
    confidence: { withConfidence: 0, withoutConfidence: 0, mean: null },
  };

  const latencies: number[] = [];
  const confidences: number[] = [];

  for (const item of cases) {
    const annotation = item.annotation;
    if (!annotation) {
      metrics.notEvaluated += 1;
      continue;
    }
    if (annotation.status === 'evaluated') metrics.evaluated += 1;
    else if (annotation.status === 'abstained') metrics.abstained += 1;
    else metrics.unavailable += 1;

    if (annotation.costUsd !== null) metrics.costUsd += annotation.costUsd;
    if (annotation.latencyMs !== null) latencies.push(annotation.latencyMs);
    if (annotation.status !== 'evaluated' || !annotation.answers) continue;

    const lane = laneOf(annotation);
    if (lane) metrics.laneDistribution[lane] = (metrics.laneDistribution[lane] ?? 0) + 1;

    for (const [id, answer] of Object.entries(annotation.answers)) {
      if (answer.confidence !== null) {
        metrics.confidence.withConfidence += 1;
        confidences.push(answer.confidence);
      } else metrics.confidence.withoutConfidence += 1;
      if (answer.type === 'score') {
        // score は離散の段ではなく**分布の確率加重平均**として返る（2026-09-18 の実測で
        // 0.06 / 1.04 / 1.79 / 1.95 など）。生の値で bucket を作ると 1 件 1 bucket になり
        // 分布として読めないので、最も近い段へ丸めて数える。
        const bucket = (metrics.scoreDistribution[id] ??= {});
        const key = String(Math.round(answer.score));
        bucket[key] = (bucket[key] ?? 0) + 1;
      }
    }

    const truth = item.truth;
    if (!truth) continue;

    if (truth.deepReviewNeeded !== null && lane) {
      if (truth.deepReviewNeeded) {
        metrics.underRouting.denominator += 1;
        if (lane === 'routine') {
          metrics.underRouting.count += 1;
          metrics.underRouting.cases.push(item.id);
        }
      }
    }

    const isProtected = (truth.protectedCategories?.length ?? 0) > 0;
    if (truth.protectedCategories !== null && isProtected) {
      metrics.lowRiskButProtected.denominator += 1;
      const allReviewFalse = SHADOW_REVIEW_QUESTION_IDS.every(
        (id) => booleanOf(annotation, id) === false,
      );
      if (lane === 'routine' || allReviewFalse) {
        metrics.lowRiskButProtected.count += 1;
        metrics.lowRiskButProtected.cases.push(item.id);
      }
    }

    if (truth.narrow !== null && truth.narrow && lane) {
      metrics.overEscalation.denominator += 1;
      if (lane === 'frontier') {
        metrics.overEscalation.count += 1;
        metrics.overEscalation.cases.push(item.id);
      }
    }

    const pairs: [string, boolean | null][] = [
      ['localized', truth.localized],
      ['reviewAuthorization', truth.authorizationTruth],
      ['reviewTimeInvariant', truth.timeInvariant],
      ['reviewPublicContract', truth.publicContractTruth],
    ];
    for (const [id, expected] of pairs) {
      if (expected === null) continue;
      const actual = booleanOf(annotation, id);
      if (actual === null) continue;
      const entry = (metrics.agreement[id] ??= { agreed: 0, denominator: 0 });
      entry.denominator += 1;
      if (actual === expected) entry.agreed += 1;
    }
  }

  metrics.latencyMs = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) };
  metrics.confidence.mean =
    confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null;
  return metrics;
}

/**
 * 「証拠が足りている」と Jev 自身が答えた境界（#2827 §3 の abstain）。
 *
 * 2026-09-18 の tune 76 件で、本文が空の 39 件は `evidenceSufficiency` が最大 0.15、
 * 本文のある 31 件は 30 件が 0.5 以上と、完全に分かれた。過少振り分け 2 件は
 * どちらも本文が空の側で、`argmax` を lane として採った結果だった。
 */
export const EVIDENCE_SUFFICIENCY_FLOOR = 0.5;

/**
 * 証拠が足りているか。**未評価・未回答は足りていない側へ倒す**
 * （unknown を false と同じ扱いにしない、ではなく「判定対象から外す」側へ寄せる）。
 */
export function hasSufficientEvidence(
  item: ShadowCase,
  floor: number = EVIDENCE_SUFFICIENCY_FLOOR,
): boolean {
  const answer = answerOf(item.annotation, 'evidenceSufficiency');
  if (!answer || answer.type !== 'score') return false;
  return answer.score >= floor;
}

export type ShadowStrata = {
  overall: ShadowMetrics;
  bySplit: Record<string, ShadowMetrics>;
  byStateSource: Record<string, ShadowMetrics>;
  /** `evidenceSufficiency` の床で分けた層。Go 条件はこの「足りている」側で読む。 */
  byEvidence: Record<string, ShadowMetrics>;
};

export function computeStrata(cases: ShadowCase[]): ShadowStrata {
  const group = <K extends string>(keyOf: (item: ShadowCase) => K) => {
    const buckets = new Map<K, ShadowCase[]>();
    for (const item of cases) {
      const key = keyOf(item);
      const bucket = buckets.get(key) ?? [];
      bucket.push(item);
      buckets.set(key, bucket);
    }
    return Object.fromEntries(
      [...buckets.entries()].map(([key, items]) => [key, computeMetrics(items)]),
    ) as Record<string, ShadowMetrics>;
  };
  return {
    overall: computeMetrics(cases),
    bySplit: group((item) => item.split),
    byStateSource: group((item) => item.stateSource),
    byEvidence: group((item) =>
      hasSufficientEvidence(item)
        ? `evidenceSufficiency >= ${EVIDENCE_SUFFICIENCY_FLOOR}`
        : `evidenceSufficiency < ${EVIDENCE_SUFFICIENCY_FLOOR}（証拠不足・未評価）`,
    ),
  };
}

/** 収集した母集団の層別件数。必須層がゼロなら警告する。 */
export type ShadowCoverage = {
  total: number;
  protected: number;
  reviewFull: number;
  codexP1: number;
  fixRoundsAtLeast2: number;
  timeInvariant: number;
  synthetic: number;
  stateSourceIssue: number;
  stateSourcePr: number;
  inputTooLarge: number;
  filesIncomplete: number;
  warnings: string[];
};

export function computeCoverage(cases: ShadowCase[]): ShadowCoverage {
  const coverage: ShadowCoverage = {
    total: cases.length,
    protected: 0,
    reviewFull: 0,
    codexP1: 0,
    fixRoundsAtLeast2: 0,
    timeInvariant: 0,
    synthetic: 0,
    stateSourceIssue: 0,
    stateSourcePr: 0,
    inputTooLarge: 0,
    filesIncomplete: 0,
    warnings: [],
  };
  for (const item of cases) {
    if (item.collectionStatus === 'input_too_large') coverage.inputTooLarge += 1;
    if (item.stateSource === 'synthetic') coverage.synthetic += 1;
    if (item.stateSource === 'issue') coverage.stateSourceIssue += 1;
    if (item.stateSource === 'pr') coverage.stateSourcePr += 1;
    const truth = item.truth;
    if (!truth) continue;
    if (truth.protectedCategories === null) coverage.filesIncomplete += 1;
    else if (truth.protectedCategories.length > 0) coverage.protected += 1;
    if (truth.reviewFull) coverage.reviewFull += 1;
    if (truth.codexP1 > 0) coverage.codexP1 += 1;
    if (truth.fixRounds !== null && truth.fixRounds >= 2) coverage.fixRoundsAtLeast2 += 1;
    if (truth.timeInvariant) coverage.timeInvariant += 1;
  }
  const required: [string, number][] = [
    ['protected', coverage.protected],
    ['reviewFull', coverage.reviewFull],
    ['codexP1', coverage.codexP1],
    ['fixRoundsAtLeast2', coverage.fixRoundsAtLeast2],
    ['timeInvariant', coverage.timeInvariant],
    ['synthetic', coverage.synthetic],
  ];
  for (const [name, count] of required)
    if (count === 0) coverage.warnings.push(`層 ${name} が 0 件。件数を増やすか層化を検討する`);
  return coverage;
}

function ratio(count: number, denominator: number): string {
  if (denominator === 0) return '— (分母 0)';
  return `${count} / ${denominator} (${((count / denominator) * 100).toFixed(1)}%)`;
}

export function formatMetrics(metrics: ShadowMetrics, heading: string): string {
  const lines = [
    `### ${heading}`,
    '',
    `| 指標 | 値 |`,
    `| --- | --- |`,
    `| 件数 | ${metrics.total} |`,
    `| 評価済み | ${metrics.evaluated} |`,
    `| abstain | ${metrics.abstained} |`,
    `| 利用不可 | ${metrics.unavailable} |`,
    `| 未評価 | ${metrics.notEvaluated} |`,
    `| 過少振り分け（要深レビュー → routine） | ${ratio(metrics.underRouting.count, metrics.underRouting.denominator)} |`,
    `| 保護対象を低リスクと回答 | ${ratio(metrics.lowRiskButProtected.count, metrics.lowRiskButProtected.denominator)} |`,
    `| 過剰 escalation（狭い → frontier） | ${ratio(metrics.overEscalation.count, metrics.overEscalation.denominator)} |`,
    `| latency p50 / p95 | ${metrics.latencyMs.p50 ?? '—'} / ${metrics.latencyMs.p95 ?? '—'} ms |`,
    `| 実費 | $${metrics.costUsd.toFixed(6)} |`,
    `| confidence 平均 | ${metrics.confidence.mean?.toFixed(3) ?? '—'} |`,
  ];
  const agreementIds = Object.keys(metrics.agreement).sort();
  if (agreementIds.length > 0) {
    lines.push('', '| 一致率 | 値 |', '| --- | --- |');
    for (const id of agreementIds) {
      const entry = metrics.agreement[id];
      if (entry) lines.push(`| ${id} | ${ratio(entry.agreed, entry.denominator)} |`);
    }
  }
  const lanes = Object.keys(metrics.laneDistribution).sort();
  if (lanes.length > 0) {
    lines.push(
      '',
      `lane 分布: ${lanes.map((lane) => `${lane}=${metrics.laneDistribution[lane]}`).join(' / ')}`,
    );
  }
  return lines.join('\n');
}

export function formatCoverage(coverage: ShadowCoverage): string {
  const lines = [
    '### 収集した母集団',
    '',
    '| 層 | 件数 |',
    '| --- | --- |',
    `| 全体 | ${coverage.total} |`,
    `| 保護対象に触れた | ${coverage.protected} |`,
    `| review:full | ${coverage.reviewFull} |`,
    `| Codex P1 あり | ${coverage.codexP1} |`,
    `| fix round 2 回以上 | ${coverage.fixRoundsAtLeast2} |`,
    `| 時間不変条件 path | ${coverage.timeInvariant} |`,
    `| 合成 | ${coverage.synthetic} |`,
    `| state 由来: issue / PR | ${coverage.stateSourceIssue} / ${coverage.stateSourcePr} |`,
    `| 入力上限超過（評価対象外） | ${coverage.inputTooLarge} |`,
    `| 変更 file 未取得（判定不能） | ${coverage.filesIncomplete} |`,
  ];
  if (coverage.warnings.length > 0)
    lines.push('', ...coverage.warnings.map((warning) => `- 警告: ${warning}`));
  return lines.join('\n');
}
