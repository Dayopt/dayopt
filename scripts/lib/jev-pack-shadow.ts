/**
 * Phase 1 の shadow 質問セット（lane / 観点）を Evaluation Pack として包む（pack 0）。
 *
 * 目的は 2 つ。(1) pack runner が既存の課金済み注釈（`tmp/jev-shadow`）と**同じ cacheKey**
 * を作ることをテストで固定し、共通化で注釈が失効しないことを保証する。(2) Phase 1 の
 * negative result（lane は定数 `standard` と区別が付かない、観点 3 問は path gate に負ける）
 * を fixture として残す。
 *
 * baseline が定数 `standard` なのは手抜きではなく Phase 1 の実測そのもの: 証拠のある
 * case で Jev は `routine` を一度も選ばず、過少振り分け 0 は定数でも出た。
 */
import type { JevAnnotation, JevState } from './jev-adapter.ts';
import type { PrEvidence } from './jev-gh-prs.ts';
import type { EvaluationPack, PackCase, PackDecision } from './jev-pack.ts';
import { SHADOW_QUESTIONS } from './jev-shadow-questions.ts';
import {
  computeCoverage,
  computeStrata,
  formatCoverage,
  formatMetrics,
  type ShadowCase,
} from './jev-shadow-report.ts';
import { SHADOW_SYNTHETIC_CASES } from './jev-shadow-synthetic.ts';
import {
  buildShadowState,
  deriveTruth,
  resolveSplit,
  type ResolveProtectedGate,
  type ShadowPrEvidence,
  type ShadowStateSource,
  type ShadowTruth,
} from './jev-shadow-truth.ts';

export type ShadowPackInput = Pick<
  ShadowPrEvidence,
  'number' | 'title' | 'body' | 'labels' | 'closingIssues'
>;

export const SHADOW_PACK_ID = 'shadow-e1';
export const SHADOW_PACK_QUESTION_VERSION = 'v1';
export const SHADOW_PACK_POLICY_VERSION = 'v1';

const UNCERTAIN_LOW = 0.35;
const UNCERTAIN_HIGH = 0.65;

function constantBaseline(): PackDecision {
  return {
    policyVersion: SHADOW_PACK_POLICY_VERSION,
    source: 'baseline',
    picks: { lane: 'standard' },
    uncertain: [],
  };
}

function shadowPolicy(
  annotation: JevAnnotation | null,
  _input: ShadowPackInput | null,
  baseline: PackDecision | null,
): PackDecision {
  if (annotation?.status !== 'evaluated' || !annotation.answers)
    return baseline ?? { ...constantBaseline(), picks: {} };
  const picks: Record<string, boolean | string> = {};
  const uncertain: string[] = [];
  for (const [id, answer] of Object.entries(annotation.answers)) {
    if (answer.type === 'choice') picks[id] = answer.choice;
    else if (answer.type === 'score') picks[id] = String(Math.round(answer.score));
    else {
      picks[id] = answer.probability >= 0.5;
      if (answer.probability >= UNCERTAIN_LOW && answer.probability <= UNCERTAIN_HIGH)
        uncertain.push(id);
    }
  }
  return { policyVersion: SHADOW_PACK_POLICY_VERSION, source: 'jev', picks, uncertain };
}

function toShadowCase(item: PackCase<ShadowPackInput, ShadowTruth>): ShadowCase {
  const prNumber = item.facets.prNumber;
  const stateSource = item.facets.stateSource;
  return {
    id: item.id,
    prNumber: typeof prNumber === 'number' ? prNumber : null,
    split: item.split,
    stateSource: (typeof stateSource === 'string' ? stateSource : 'synthetic') as ShadowStateSource,
    collectionStatus: item.collectionStatus,
    truth: item.truth,
    annotation: item.annotation,
  };
}

export function createShadowPack({
  resolveGate,
}: {
  resolveGate: ResolveProtectedGate;
}): EvaluationPack<ShadowPackInput, ShadowTruth, PrEvidence> {
  return {
    id: SHADOW_PACK_ID,
    questionVersion: SHADOW_PACK_QUESTION_VERSION,
    policyVersion: SHADOW_PACK_POLICY_VERSION,
    questions: SHADOW_QUESTIONS,
    synthetic: SHADOW_SYNTHETIC_CASES.map((synthetic) => ({
      id: synthetic.id,
      purpose: synthetic.purpose,
      expectation: synthetic.expectation,
      state: synthetic.state as unknown as JevState,
    })),
    deriveCases(prs) {
      return prs.map((pr) => ({
        id: `pr-${pr.number}`,
        split: resolveSplit(pr.number),
        input: {
          number: pr.number,
          title: pr.title,
          body: pr.body,
          labels: pr.labels,
          closingIssues: pr.closingIssues,
        },
        evidence: pr,
        facets: { prNumber: pr.number, stateSource: buildShadowState(pr).state.source },
      }));
    },
    buildState(input) {
      const { state, droppedSections } = buildShadowState(input);
      // state を一切加工しない。key を 1 つ足すだけで既存の課金済み注釈が失効する。
      return { state: state as unknown as JevState, dropped: droppedSections };
    },
    baseline() {
      return constantBaseline();
    },
    policy: shadowPolicy,
    truth(evidence) {
      return deriveTruth(evidence, { resolveGate });
    },
    metrics(cases) {
      const shadowCases = cases.map(toShadowCase);
      const strata = computeStrata(shadowCases);
      const coverage = computeCoverage(shadowCases);
      const sections = [formatCoverage(coverage), '', formatMetrics(strata.overall, '全体')];
      for (const [split, metrics] of Object.entries(strata.bySplit))
        sections.push('', formatMetrics(metrics, `split: ${split}`));
      // PR 由来 state には事後情報が混ざりうる（Phase 1 の実測）。issue / PR / synthetic の
      // 層別を落とすと、PR 由来だけで出た数字を全体性能として読んでしまう。
      for (const [source, metrics] of Object.entries(strata.byStateSource))
        sections.push('', formatMetrics(metrics, `state 由来: ${source}`));
      for (const [bucket, metrics] of Object.entries(strata.byEvidence))
        sections.push('', formatMetrics(metrics, bucket));
      return {
        summary: JSON.parse(JSON.stringify({ coverage, strata })),
        markdown: sections.join('\n'),
      };
    },
  };
}
