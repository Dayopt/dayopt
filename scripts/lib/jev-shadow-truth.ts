/**
 * Phase 1 shadow 評価の「正解ラベル」導出（#2827）。
 *
 * **正解は Jev ではなく repo の事実から作る。** 保護対象 path、`review:full` label、
 * Codex の P1/P2、ready 化後の fix round、時間不変条件 path から、「深いレビューが
 * 実際に要ったか」「狭い作業だったか」を機械的に導く。
 *
 * **着手時 routing の評価に着手後の結果を入力として漏らさない**（#2827 §5）。
 * ここで導いた label は report の突き合わせにだけ使い、Jev へ送る state には入れない。
 * state 生成（`buildShadowState`）が本 file に同居しているのは、落とすべき section の
 * 判断が label の由来と表裏だからで、両者を混ぜるためではない。
 *
 * 純粋関数だけを置く。`resolveProtectedPathGate` は呼び出し側が注入する
 * （`scripts/ci/protected-path-gate.mjs` は top-level await を持ち、tsx が CJS へ
 * 落とす `.ts` からは静的 import できない。CLI 側で動的 import して渡す）。
 */
import { createHash } from 'node:crypto';

import { JEV_MAX_INPUT_BYTES, jevInputBytes, type JevJsonValue } from './jev-adapter.ts';
import { SHADOW_QUESTION_SET_ID, SHADOW_QUESTIONS } from './jev-shadow-questions.ts';

/** 保護対象 glob を観点へ写像する時の分類。 */
export type ProtectedCategory =
  | 'auth-mcp'
  | 'migration'
  | 'billing'
  | 'external-calendar'
  | 'timeblock-highrisk'
  | 'system-api'
  | 'guardrails';

/**
 * glob → category。**`PROTECTED_PATH_GLOBS` の全 glob を網羅する**ことを test で固定する
 * （gate 側に glob が増えた時、写像漏れを `unknown` へ黙って落とさない）。
 */
export const PROTECTED_GLOB_CATEGORIES: Record<string, ProtectedCategory> = {
  'apps/product/src/features/auth/**': 'auth-mcp',
  'apps/product/src/app/oauth/**': 'auth-mcp',
  'apps/product/src/app/[locale]/oauth/**': 'auth-mcp',
  'apps/product/src/app/api/oauth/**': 'auth-mcp',
  'apps/product/src/app/.well-known/oauth-authorization-server/**': 'auth-mcp',
  'apps/product/src/app/.well-known/oauth-protected-resource/**': 'auth-mcp',
  'apps/product/src/app/[locale]/(auth)/auth/**': 'auth-mcp',
  'apps/product/src/proxy.ts': 'auth-mcp',
  'apps/product/src/lib/supabase/middleware.ts': 'auth-mcp',
  'apps/product/src/lib/trpc/session-auth-context.ts': 'auth-mcp',
  'apps/product/src/lib/auth/**': 'auth-mcp',
  'apps/product/src/lib/safe-redirect.ts': 'auth-mcp',
  'apps/product/src/lib/oauth-server/**': 'auth-mcp',
  'apps/product/src/app/api/integrations/**': 'auth-mcp',
  'apps/product/src/app/mcp/**': 'auth-mcp',
  'apps/product/src/app/api/mcp/**': 'auth-mcp',
  'apps/product/src/lib/mcp/**': 'auth-mcp',
  'supabase/migrations/**': 'migration',
  'supabase/functions/**': 'migration',
  'apps/product/src/lib/stripe/**': 'billing',
  'apps/product/src/lib/billing/**': 'billing',
  'apps/product/src/app/api/webhooks/**': 'billing',
  'apps/product/src/features/settings/server/billing-*.ts': 'billing',
  'apps/product/src/features/external-calendar/server/providers/**': 'external-calendar',
  'apps/product/src/app/api/cron/calendar-account-deletion-settle/**': 'external-calendar',
  'apps/product/src/features/external-calendar/server/account-deletion.ts': 'external-calendar',
  'apps/product/src/features/external-calendar/server/token-rotation.ts': 'external-calendar',
  'apps/product/src/features/external-calendar/server/revoke-outbox.ts': 'external-calendar',
  'apps/product/src/features/timeblock/server/mcp-*': 'timeblock-highrisk',
  'apps/product/src/features/timeblock/server/private-timeblock-search-query.ts':
    'timeblock-highrisk',
  'apps/product/src/app/api/v1/system/**': 'system-api',
  '.husky/**': 'guardrails',
  '.codex/**': 'guardrails',
  '.claude/settings.json': 'guardrails',
  'scripts/agent/**': 'guardrails',
  'scripts/hooks/**': 'guardrails',
  'scripts/tasks/finish-branch.sh': 'guardrails',
  'scripts/ci/protected-path-gate.mjs': 'guardrails',
  'scripts/ci/check.mjs': 'guardrails',
  '.github/workflows/ci.yml': 'guardrails',
  'scripts/lib/validation-plan.mjs': 'guardrails',
  'scripts/lib/validation-plan.test.ts': 'guardrails',
  'scripts/lib/review-policy.mjs': 'guardrails',
  'scripts/lib/review-policy.test.ts': 'guardrails',
  'scripts/ci/validation-gate.mjs': 'guardrails',
  'scripts/ci/validation-gate.test.ts': 'guardrails',
  '.github/workflows/validation-gate.yml': 'guardrails',
  '.github/workflows/promote.yml': 'guardrails',
  'scripts/ci/release-impact.mjs': 'guardrails',
  'scripts/ci/production-release.mjs': 'guardrails',
  'scripts/ci/release-workflow-contract.test.ts': 'guardrails',
  'scripts/ci/release-impact.test.ts': 'guardrails',
  'scripts/__tests__/protected-path-gate-contract.test.ts': 'guardrails',
  'apps/product/src/features/timeblock/server/private-search-boundary-contract.test.ts':
    'guardrails',
  'scripts/ci/production-config-audit.mjs': 'guardrails',
  'apps/product/production-build-gate.mjs': 'guardrails',
  'apps/web/production-build-gate.mjs': 'guardrails',
  '.github/workflows/production-config-audit.yml': 'guardrails',
};

/** `reviewAuthorization` の正解に対応する category。 */
export const AUTHORIZATION_CATEGORIES: readonly ProtectedCategory[] = [
  'auth-mcp',
  'system-api',
  'guardrails',
];

/** `reviewPublicContract` の正解に対応する category。 */
export const PUBLIC_CONTRACT_CATEGORIES: readonly ProtectedCategory[] = [
  'auth-mcp',
  'billing',
  'external-calendar',
  'system-api',
  'timeblock-highrisk',
];

/**
 * 時間不変条件の安全網が置かれている領域（#2489 / #2503）。
 * 保護対象 glob には無い（feature 全体は必須側から外した）ので、独自に持つ。
 */
export const TIME_INVARIANT_PREFIXES = [
  'apps/product/src/features/timeblock/',
  'apps/product/src/lib/time/',
];

/** REST / GraphQL いずれの login 表記でも Codex bot を同じ値にする。 */
const CODEX_BOT_LOGIN = 'chatgpt-codex-connector';

export function isCodexBotLogin(login: string | null | undefined): boolean {
  return String(login ?? '').replace(/\[bot\]$/, '') === CODEX_BOT_LOGIN;
}

/** `trace.mjs:409` と同じ badge 表記。Codex が本文先頭に貼る画像。 */
const P1_BADGE = /!\[P1 Badge\]/;
const P2_BADGE = /!\[P2 Badge\]/;

export type ShadowFile = { filename: string; previousFilename?: string | null };

export type ShadowTimelineItem = {
  type: 'ready_for_review' | 'commit' | 'force_push';
  at: string | null;
};

export type ShadowReviewThread = { authorLogin: string | null; body: string };

export type ShadowIssueEvidence = {
  number: number;
  title: string;
  body: string;
  labels: string[];
};

export type ShadowPrEvidence = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  mergedAt: string | null;
  changedFiles: number;
  /** `pulls/N/files` が全件取れたか。取れていなければ path 由来の label は null。 */
  filesComplete: boolean;
  files: ShadowFile[];
  reviewThreads: ShadowReviewThread[];
  timeline: ShadowTimelineItem[];
  closingIssues: ShadowIssueEvidence[];
};

export type ShadowTruth = {
  /** 保護対象に触れたか。files 未取得なら null（unknown と false を区別する）。 */
  protectedCategories: ProtectedCategory[] | null;
  timeInvariant: boolean | null;
  reviewFull: boolean;
  codexP1: number;
  codexP2: number;
  fixRounds: number | null;
  fixRoundsReason: 'counted' | 'force_pushed' | 'unknown';
  readySource: 'event' | 'createdAt';
  localized: boolean | null;
  areas: string[] | null;
  /** 導出値。report の分母・分子はこれで決める。 */
  deepReviewNeeded: boolean | null;
  narrow: boolean | null;
  authorizationTruth: boolean | null;
  publicContractTruth: boolean | null;
};

export type ResolveProtectedGate = (files: string[]) => {
  required: boolean;
  reason?: string;
  auditContract: boolean;
};

/** 変更 file を「機能領域」へ畳む。`localized` の正解に使う。 */
export function resolveArea(path: string): string {
  const featureMatch = /^apps\/product\/src\/features\/([^/]+)\//.exec(path);
  if (featureMatch) return `feature:${featureMatch[1]}`;
  const segments = path.split('/');
  if (segments.length <= 1) return `root:${path}`;
  return segments.slice(0, 2).join('/');
}

export function isTimeInvariantPath(path: string): boolean {
  return TIME_INVARIANT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * ready 化の起点。
 *
 * merged PR が draft を経ていれば必ず `ready_for_review` を持つので、**無い＝最初から
 * ready**。`null` にして母集団から落とすのは誤り。どちらを使ったかは記録する。
 */
export function resolveReadyAt(pr: Pick<ShadowPrEvidence, 'createdAt' | 'timeline'>): {
  readyAt: string;
  readySource: 'event' | 'createdAt';
} {
  const event = pr.timeline
    .filter((item) => item.type === 'ready_for_review' && item.at)
    .map((item) => item.at as string)
    .sort()[0];
  if (event) return { readyAt: event, readySource: 'event' };
  return { readyAt: pr.createdAt, readySource: 'createdAt' };
}

/**
 * ready 化後の fix round 数。
 *
 * **ready 後に force-push があれば判定不能（null）。** main への追従 rebase は全 commit の
 * committedDate を書き換えるので、修正ゼロの PR が「全 commit 数だけ直した」に化ける。
 */
export function countFixRounds(pr: Pick<ShadowPrEvidence, 'createdAt' | 'timeline'>): {
  fixRounds: number | null;
  fixRoundsReason: ShadowTruth['fixRoundsReason'];
  readySource: 'event' | 'createdAt';
} {
  const { readyAt, readySource } = resolveReadyAt(pr);
  const readyMs = Date.parse(readyAt);
  if (!Number.isFinite(readyMs))
    return { fixRounds: null, fixRoundsReason: 'unknown', readySource };
  const forcePushed = pr.timeline.some((item) => {
    if (item.type !== 'force_push' || !item.at) return false;
    const ts = Date.parse(item.at);
    return Number.isFinite(ts) && ts > readyMs;
  });
  if (forcePushed) return { fixRounds: null, fixRoundsReason: 'force_pushed', readySource };
  const commits = pr.timeline.filter((item) => {
    if (item.type !== 'commit' || !item.at) return false;
    const ts = Date.parse(item.at);
    return Number.isFinite(ts) && ts > readyMs;
  });
  return { fixRounds: commits.length, fixRoundsReason: 'counted', readySource };
}

export function countCodexBadges(threads: ShadowReviewThread[]): { p1: number; p2: number } {
  let p1 = 0;
  let p2 = 0;
  for (const thread of threads) {
    if (!isCodexBotLogin(thread.authorLogin)) continue;
    if (P1_BADGE.test(thread.body)) p1 += 1;
    if (P2_BADGE.test(thread.body)) p2 += 1;
  }
  return { p1, p2 };
}

/** 変更 file から保護対象 category を集める。gate は先頭一致しか返さないので 1 件ずつ呼ぶ。 */
export function resolveProtectedCategories(
  files: ShadowFile[],
  resolveGate: ResolveProtectedGate,
): ProtectedCategory[] {
  const categories = new Set<ProtectedCategory>();
  for (const file of files) {
    for (const path of [file.filename, file.previousFilename ?? null]) {
      if (!path) continue;
      const result = resolveGate([path]);
      if (!result.required || !result.reason) continue;
      const category = PROTECTED_GLOB_CATEGORIES[result.reason];
      if (category) categories.add(category);
    }
  }
  return [...categories].sort();
}

export function deriveTruth(
  pr: ShadowPrEvidence,
  { resolveGate }: { resolveGate: ResolveProtectedGate },
): ShadowTruth {
  const labels = pr.labels;
  const reviewFull = labels.includes('review:full');
  const { p1, p2 } = countCodexBadges(pr.reviewThreads);
  const { fixRounds, fixRoundsReason, readySource } = countFixRounds(pr);

  if (!pr.filesComplete) {
    return {
      protectedCategories: null,
      timeInvariant: null,
      reviewFull,
      codexP1: p1,
      codexP2: p2,
      fixRounds,
      fixRoundsReason,
      readySource,
      localized: null,
      areas: null,
      deepReviewNeeded: null,
      narrow: null,
      authorizationTruth: null,
      publicContractTruth: null,
    };
  }

  const paths = pr.files.map((file) => file.filename);
  const categories = resolveProtectedCategories(pr.files, resolveGate);
  const areas = [...new Set(paths.map(resolveArea))].sort();
  const timeInvariant = paths.some(isTimeInvariantPath);
  const isProtected = categories.length > 0;

  return {
    protectedCategories: categories,
    timeInvariant,
    reviewFull,
    codexP1: p1,
    codexP2: p2,
    fixRounds,
    fixRoundsReason,
    readySource,
    localized: areas.length === 1,
    areas,
    deepReviewNeeded: isProtected || reviewFull || p1 > 0,
    // `fixRounds <= 1` は fixRounds が null の時 JS では true になる。明示的に外す。
    narrow: !isProtected && p1 === 0 && fixRounds !== null && fixRounds <= 1,
    authorizationTruth: categories.some((category) => AUTHORIZATION_CATEGORIES.includes(category)),
    publicContractTruth: categories.some((category) =>
      PUBLIC_CONTRACT_CATEGORIES.includes(category),
    ),
  };
}

/**
 * PR 本文のうち **着手時点で埋まっている section** だけ残す。
 *
 * PR template には `## Review focus`（auth / RLS / billing / migration / time boundary …）
 * という欄があり、これは `reviewAuthorization` 等の**人間による答えそのもの**。
 * `## 検証` には Codex の結果が書かれる。そのまま送ると一致率が「Jev が判断できるか」
 * ではなく「Jev が人間の申告を読めるか」になる。
 */
export const PR_BODY_KEEP_SECTIONS = [
  '関連 Issue',
  '復唱',
  '作業計画',
  '触るファイル領域',
  '目的と invariant',
];

export function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}

/** 見出しが 1 つも無い PR 本文を落とした時に記録する印。 */
export const FREEFORM_BODY_MARKER = '(見出しなしの本文)';

/**
 * `## ` 見出しで分割し、keep 対象の見出しだけ残す。見出しの前置きは落とす。
 *
 * **見出しが 1 つも無い本文は全部落とす。** この repo の PR template は見出し必須なので、
 * 見出しの無い本文は template を使わずに後から書いた要約であり、実測（2026-09-18、
 * 直近 100 PR）では該当 11 件のうち 10 件が「独立レビューの指摘 3 件を修正」「pre-push
 * 成功」「`review:full` 対象です」といった**作業後の記述**を含んでいた。全文を残すと、
 * 観点 boolean の一致率が「Jev が判断できるか」ではなく「人間の申告を読めるか」になる。
 * 題名と label は残るので case 自体は評価できる。
 */
export function filterPrBodySections(body: string): {
  body: string;
  droppedSections: string[];
} {
  const withoutComments = stripHtmlComments(body);
  const parts = withoutComments.split(/^##[ \t]+/m);
  if (parts.length <= 1) {
    const trimmed = withoutComments.trim();
    return trimmed
      ? { body: '', droppedSections: [FREEFORM_BODY_MARKER] }
      : { body: '', droppedSections: [] };
  }
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const part of parts.slice(1)) {
    const heading = part.split('\n', 1)[0]?.trim() ?? '';
    const keep = PR_BODY_KEEP_SECTIONS.some((name) => heading.startsWith(name));
    if (keep) kept.push(`## ${part.trimEnd()}`);
    else dropped.push(heading);
  }
  return { body: kept.join('\n\n').trim(), droppedSections: dropped };
}

/** 正解ラベルそのものになる label を state から外す。 */
export function sanitizeLabels(labels: string[]): string[] {
  return labels.filter((label) => !label.startsWith('review:') && !label.startsWith('status:'));
}

export type ShadowStateSource = 'issue' | 'pr' | 'synthetic';

export type ShadowState = {
  source: ShadowStateSource;
  title: string;
  body: string;
  labels?: string[];
};

/**
 * Jev へ送る state。**diff・変更 file 一覧・review コメント・正解ラベルは送らない。**
 *
 * linked issue があればそれを使う（着手前に存在した文書なので漏れが少ない）。無ければ
 * PR 本文を着手時 section だけに削る。
 */
export function buildShadowState(
  pr: Pick<ShadowPrEvidence, 'title' | 'body' | 'labels' | 'closingIssues'>,
): {
  state: ShadowState;
  droppedSections: string[];
} {
  const issue = pr.closingIssues[0];
  if (issue) {
    return {
      state: {
        source: 'issue',
        title: issue.title,
        body: stripHtmlComments(issue.body).trim(),
        labels: sanitizeLabels(issue.labels),
      },
      droppedSections: [],
    };
  }
  const { body, droppedSections } = filterPrBodySections(pr.body);
  return {
    state: { source: 'pr', title: pr.title, body, labels: sanitizeLabels(pr.labels) },
    droppedSections,
  };
}

export function buildShadowRequest(state: ShadowState) {
  return {
    questionSetId: SHADOW_QUESTION_SET_ID,
    questions: SHADOW_QUESTIONS,
    state: state as unknown as Record<string, JevJsonValue>,
  };
}

/**
 * 上限判定は raw の本文長ではなく **実 request の直列化結果**で行う。
 * JSON escape で改行が 2 バイトになるため、raw で測ると通ってから adapter で落ちる。
 */
export function exceedsInputBudget(state: ShadowState): boolean {
  const { longest } = jevInputBytes(buildShadowRequest(state));
  return longest > JEV_MAX_INPUT_BYTES;
}

/** 70 / 30 の split。番号だけで決まるので、何度収集し直しても同じ。 */
export function resolveSplit(prNumber: number): 'tune' | 'holdout' {
  const digest = createHash('sha256').update(`pr:${prNumber}`).digest();
  return digest[0] % 100 < 70 ? 'tune' : 'holdout';
}
