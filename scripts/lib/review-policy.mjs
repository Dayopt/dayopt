/**
 * Review policy（#2796）の純粋評価。plan の review 要件と、PR の review / comment / thread
 * evidence から「指定 scope の独立レビューが最新 head について成立しているか」を返す。
 * ネットワーク・環境変数には触れない。
 *
 * 実測した Codex（GitHub 連携）の応答形（2026-09-16、PR #2799 / #2800 / #2802）:
 * - 指摘あり: `chatgpt-codex-connector[bot]` の PR review（state COMMENTED、commit_id = 対象 head、
 *   body に `**Reviewed commit:** \`<short sha>\``）+ inline comment（P1 / P2 badge）
 * - 指摘なし: 同 bot の issue comment「Codex Review: Didn't find any major issues.」+ Reviewed commit
 * - 進捗表: 同 bot の issue comment `<!-- codex-pull-request-review-summary -->` の表
 *   （Review / Status / Commit / trigger。Completed と short sha）
 * - 依頼: 人間の `@codex review` comment。bot は実行中に 👀、指摘なし完了で 👍 を付ける
 *
 * 判定の原則:
 * - 完了証拠は bot 名義の review / no-findings comment で、対象 commit が現 head と一致するもの。
 *   依頼 comment の投稿成功・👀 / 👍 反応・summary 表だけでは完了にしない
 * - 指摘は「裁定の存在」を機械確認する: thread が resolve 済みで、bot 以外の返信がある。
 *   黙って resolve した thread、未解決 thread は合格にしない。裁定内容の正しさは証明しない
 * - 古い head の review は stale。head / policy が動いたら再評価する
 * - 高リスク（plan.review.protected）は `[review-summary]`（pr-cross-review skill の固定差分契約）
 *   の `head:` が現 head と一致し `status:` が reviewed であることを別条件として要求する
 * - EXPLICIT AUTHORITY（本番操作）は本文 checkbox や label から推定しない。常に未承認として表示する
 */

export const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
export const REVIEW_STATUS_CONTEXT = 'Review policy (shadow)';
export const REVIEW_REQUEST_PATTERN = /^\s*@codex\s+review\b/im;
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
const REVIEWED_COMMIT = /\*\*Reviewed commit:?\*\*:?\s*`([0-9a-f]{7,40})`/i;
const HIGH_RISK_MARKER = /^\[review-summary\]\s*$/m;
const SHA = /^[a-f0-9]{40}$/;
/** 依頼から応答が無いまま経過したら unknown（Codex 障害 / 上限）とみなす時間。 */
export const REVIEW_RESPONSE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @typedef {{ id: number, authorLogin: string, authorType: string, state: string,
 *   commitId: string, submittedAt: string, htmlUrl: string, body: string }} ReviewEvidence
 * @typedef {{ id: number, authorLogin: string, authorType: string, body: string,
 *   createdAt: string, htmlUrl: string }} CommentEvidence
 * @typedef {{ id: string, isResolved: boolean, isOutdated: boolean, path: string | null,
 *   comments: { authorLogin: string, reviewId: string | null, body: string }[] }} ThreadEvidence
 * @typedef {{ headSha: string, headCommittedAt: string | null,
 *   pr: { number: number, state: string, draft: boolean },
 *   reviews: ReviewEvidence[], comments: CommentEvidence[], threads: ThreadEvidence[],
 *   reviewNodeIds?: Record<string, string> }} ReviewPolicyEvidence
 */

const isBot = (entry) => entry.authorLogin === CODEX_LOGIN;
const matchesHead = (short, headSha) =>
  typeof short === 'string' && short.length >= 7 && headSha.startsWith(short.toLowerCase());

/** bot の完了証拠（review または no-findings comment）を集める。target は対象 commit（不明は null）。 */
export function collectCodexCompletions(evidence) {
  const completions = [];
  for (const review of evidence.reviews ?? []) {
    if (!isBot(review)) continue;
    const short = review.body?.match(REVIEWED_COMMIT)?.[1]?.toLowerCase() ?? null;
    const target = SHA.test(review.commitId ?? '') ? review.commitId : null;
    completions.push({
      kind: 'review',
      id: review.id,
      target: target && (short === null || target.startsWith(short)) ? target : null,
      url: review.htmlUrl,
      at: review.submittedAt,
    });
  }
  for (const comment of evidence.comments ?? []) {
    if (!isBot(comment) || !/^\s*Codex Review:/i.test(comment.body ?? '')) continue;
    const short = comment.body.match(REVIEWED_COMMIT)?.[1]?.toLowerCase() ?? null;
    completions.push({
      kind: 'no-findings',
      id: comment.id,
      target: short,
      url: comment.htmlUrl,
      at: comment.createdAt,
    });
  }
  return completions;
}

/** summary 表から現 head の行を読む（完了証拠ではなく、実行中 / 失敗の検出用）。 */
export function readCodexSummaryRow(evidence, headSha) {
  const summary = (evidence.comments ?? []).find(
    (comment) => isBot(comment) && comment.body?.includes(SUMMARY_MARKER),
  );
  if (!summary) return null;
  const rows = summary.body
    .split('\n')
    .filter((line) => /^\|/.test(line) && !/^\|\s*-/.test(line) && !/^\|\s*Review\s*\|/i.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map((cells) => ({
      status: cells[2] ?? '',
      commit: cells[3]?.match(/`([0-9a-f]{7,40})`/)?.[1]?.toLowerCase() ?? null,
    }));
  return rows.find((row) => row.commit && matchesHead(row.commit, headSha)) ?? null;
}

/** 現 head の bot review に属する thread の裁定状況。 */
function adjudicationOf(evidence, headReviewIds) {
  const threads = (evidence.threads ?? []).filter(
    (thread) =>
      thread.comments.length > 0 &&
      isBot(thread.comments[0]) &&
      thread.comments.some((comment) => headReviewIds.has(comment.reviewId ?? '')),
  );
  const unresolved = threads.filter((thread) => !thread.isResolved);
  const silent = threads.filter(
    (thread) => thread.isResolved && !thread.comments.some((comment) => !isBot(comment)),
  );
  return { findings: threads.length, unresolved: unresolved.length, silent: silent.length };
}

/** 高リスクの固定差分契約（`[review-summary]`）の現 head 分。 */
export function readHighRiskSummary(evidence, headSha) {
  const parsed = (evidence.comments ?? [])
    .filter(
      (comment) =>
        !isBot(comment) &&
        comment.authorType !== 'Bot' &&
        HIGH_RISK_MARKER.test(comment.body ?? ''),
    )
    .map((comment) => {
      const field = (name) =>
        comment.body.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
      return { id: comment.id, url: comment.htmlUrl, head: field('head'), status: field('status') };
    });
  const forHead = parsed.filter((entry) => entry.head === headSha);
  if (forHead.length === 0) return { status: parsed.length ? 'stale' : 'missing', entry: null };
  const latest = forHead[forHead.length - 1];
  if (/\b(not-run|stale|invalid)\b/.test(latest.status)) return { status: 'stale', entry: latest };
  if (/\bpartial\b/.test(latest.status)) return { status: 'partial', entry: latest };
  if (/\breviewed\b/.test(latest.status)) return { status: 'satisfied', entry: latest };
  return { status: 'unknown', entry: latest };
}

/**
 * @param {{ plan: any, evidence: ReviewPolicyEvidence, now?: Date, validationVerdict?: string }} input
 */
export function evaluateReviewPolicy({
  plan,
  evidence,
  now = new Date(),
  validationVerdict = 'unknown',
}) {
  const headSha = plan?.identity?.headSha ?? '';
  const required = plan?.review?.status ?? 'indeterminate';
  const base = {
    context: REVIEW_STATUS_CONTEXT,
    headSha,
    required,
    focus: plan?.review?.focus ?? [],
    protected: plan?.review?.protected === true,
    authority: {
      code: plan?.authority?.code ?? 'CHECKPOINT',
      production: 'EXPLICIT AUTHORITY',
      productionAuthorized: false,
      note: 'Production authorization is never inferred from PR text, labels or review results',
    },
    trigger: { shouldRequest: false, reason: '' },
    highRisk: null,
    evidence: null,
  };
  if (!SHA.test(headSha) || evidence?.headSha !== headSha)
    return { ...base, state: 'unknown', verdict: 'blocked', reason: 'head revision unresolved' };
  if (required === 'indeterminate')
    return { ...base, state: 'unknown', verdict: 'blocked', reason: plan.review.reason };
  if (required === 'not-applicable')
    return { ...base, state: 'not-required', verdict: 'not-required', reason: plan.review.reason };

  const completions = collectCodexCompletions(evidence);
  const forHead = completions.filter((entry) => entry.target && matchesHead(entry.target, headSha));
  const stale = completions.filter((entry) => entry.target && !matchesHead(entry.target, headSha));
  const unknownTarget = completions.filter((entry) => entry.target === null);
  const requests = (evidence.comments ?? []).filter(
    (comment) => !isBot(comment) && REVIEW_REQUEST_PATTERN.test(comment.body ?? ''),
  );
  const headAt = evidence.headCommittedAt ? Date.parse(evidence.headCommittedAt) : NaN;
  const openRequests = requests.filter(
    (request) => Number.isNaN(headAt) || Date.parse(request.createdAt) >= headAt,
  );
  const summaryRow = readCodexSummaryRow(evidence, headSha);
  const prOpen = evidence.pr?.state === 'open' && !evidence.pr?.draft;

  let state;
  let reason;
  let adjudication = null;
  if (forHead.length > 0) {
    const headReviewIds = new Set(
      forHead
        .filter((entry) => entry.kind === 'review')
        .map((entry) => evidence.reviewNodeIds?.[String(entry.id)] ?? String(entry.id)),
    );
    adjudication = adjudicationOf(evidence, headReviewIds);
    if (adjudication.unresolved > 0) {
      state = 'pending-adjudication';
      reason = `${adjudication.unresolved} Codex thread(s) unresolved for this head`;
    } else if (adjudication.silent > 0) {
      state = 'pending-adjudication';
      reason = `${adjudication.silent} Codex thread(s) resolved without a reply (fix / rebuttal / issue)`;
    } else {
      state = 'complete';
      reason = `Codex reviewed ${headSha.slice(0, 9)} (${adjudication.findings} finding(s), all adjudicated)`;
    }
  } else if (summaryRow && !/completed/i.test(summaryRow.status)) {
    state = /fail|error/i.test(summaryRow.status) ? 'failed' : 'pending';
    reason = `Codex summary reports "${summaryRow.status}" for this head`;
  } else if (openRequests.length > 0) {
    const latest = openRequests[openRequests.length - 1];
    const waited = now.getTime() - Date.parse(latest.createdAt);
    if (waited > REVIEW_RESPONSE_TIMEOUT_MS) {
      state = 'unknown';
      reason = `No Codex response ${Math.round(waited / 60000)} min after the request; provide an equivalent independent review`;
    } else {
      state = 'pending';
      reason = 'Codex review requested; awaiting a response for this head';
    }
  } else if (unknownTarget.length > 0) {
    state = 'unknown';
    reason = 'Codex response found but its target revision could not be determined';
  } else if (stale.length > 0) {
    state = 'stale';
    reason = `Codex reviewed ${stale[stale.length - 1].target.slice(0, 9)}, not the current head`;
  } else {
    state = 'not-started';
    reason = 'No independent review for this head';
  }

  let highRisk = null;
  if (base.protected) {
    highRisk = readHighRiskSummary(evidence, headSha);
    highRisk.reason =
      highRisk.status === 'satisfied'
        ? 'Fixed-diff review summary matches this head'
        : `Fixed-diff review summary for this head is ${highRisk.status}`;
  }

  const shouldRequest =
    prOpen &&
    ['not-started', 'stale'].includes(state) &&
    openRequests.length === 0 &&
    validationVerdict !== 'blocked';
  const trigger = {
    shouldRequest,
    reason: shouldRequest
      ? `Request @codex review for ${headSha.slice(0, 9)} (${state})`
      : !prOpen
        ? 'PR is not ready for review'
        : validationVerdict === 'blocked'
          ? 'Validation is blocked; do not request a review of a failing head'
          : openRequests.length > 0
            ? 'A request for this head already exists'
            : `No request needed (${state})`,
  };

  // blocked = 自動では前へ進まない状態（無応答 / 失敗 / 未裁定 / 対象不明 / 契約の partial）。
  // pending = まだ行うべき手順が残っている状態（未依頼 / 依頼中 / stale / 固定差分レビュー未実施）。
  const highRiskOk = !highRisk || highRisk.status === 'satisfied';
  const highRiskBlocked = highRisk !== null && ['partial', 'unknown'].includes(highRisk.status);
  const stateBlocked = ['unknown', 'failed', 'pending-adjudication'].includes(state);
  const verdict =
    stateBlocked || highRiskBlocked
      ? 'blocked'
      : state === 'complete' && highRiskOk
        ? 'satisfied'
        : 'pending';
  return {
    ...base,
    state,
    verdict,
    reason,
    trigger,
    highRisk,
    evidence: {
      completions: forHead.map((entry) => ({ kind: entry.kind, url: entry.url, at: entry.at })),
      staleCompletions: stale.length,
      requests: openRequests.map((request) => request.htmlUrl),
      adjudication,
    },
  };
}

export function toReviewCommitStatus(result) {
  const description = (text) => text.slice(0, 140);
  if (result.verdict === 'satisfied' || result.verdict === 'not-required')
    return { state: 'success', description: description(result.reason) };
  if (result.verdict === 'pending')
    return { state: 'pending', description: description(result.reason) };
  return { state: 'failure', description: description(`${result.state}: ${result.reason}`) };
}

export function formatReviewPolicy(result) {
  const lines = [
    '## Review policy (shadow)',
    '',
    `Verdict: **${result.verdict}** (${result.state}) — ${result.reason}`,
    `Required: ${result.required}; focus: ${result.focus.join(', ') || 'none'}; protected: ${result.protected}`,
    `Trigger: ${result.trigger.shouldRequest ? 'would request' : 'no request'} — ${result.trigger.reason}`,
  ];
  if (result.highRisk)
    lines.push(`High-risk contract: ${result.highRisk.status} — ${result.highRisk.reason}`);
  lines.push(
    `Authority: code=${result.authority.code}; production=${result.authority.production} (authorized: ${result.authority.productionAuthorized})`,
  );
  if (result.evidence?.completions?.length)
    lines.push('', ...result.evidence.completions.map((entry) => `- ${entry.kind}: ${entry.url}`));
  lines.push(
    '',
    'Shadow only: review remains advisory; this status is not required and no review is requested automatically.',
  );
  return `${lines.join('\n')}\n`;
}
