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
 * - 高リスクでも追加レビューは要求しない。既存の `[review-summary]` は任意の証跡として読む
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
 * @typedef {{ id: number, authorLogin: string, authorType: string, authorAssociation?: string,
 *   body: string, createdAt: string, htmlUrl: string }} CommentEvidence
 * @typedef {{ id: string, isResolved: boolean, isOutdated: boolean, path: string | null,
 *   comments: { authorLogin: string, authorType?: string, authorAssociation?: string,
 *   reviewId: string | null, body: string }[] }} ThreadEvidence
 * @typedef {{ headSha: string, headCommittedAt: string | null, headObservedAt?: string | null,
 *   pr: { number: number, state: string, draft: boolean },
 *   reviews: ReviewEvidence[], comments: CommentEvidence[], threads: ThreadEvidence[],
 *   reviewNodeIds?: Record<string, string> }} ReviewPolicyEvidence
 */

/** REST は `name[bot]`、GraphQL の author.login は `name`。suffix を正規化して照合する（Codex P2）。 */
const normalizeLogin = (login) => (login ?? '').replace(/\[bot\]$/, '');
const isBot = (entry) => normalizeLogin(entry.authorLogin) === normalizeLogin(CODEX_LOGIN);
/** 高リスク契約の投稿者として受理する author_association（公開 PR では第三者も comment できる）。 */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/** 完了証拠として受理する submitted review の state（PENDING / DISMISSED は除外）。 */
const SUBMITTED_STATES = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);
const matchesHead = (short, headSha) =>
  typeof short === 'string' && short.length >= 7 && headSha.startsWith(short.toLowerCase());

function headAtOf(evidence) {
  return evidence.headObservedAt
    ? Date.parse(evidence.headObservedAt)
    : evidence.headCommittedAt
      ? Date.parse(evidence.headCommittedAt)
      : NaN;
}

/** bot の完了証拠（review または no-findings comment）を集める。target は対象 commit（不明は null）。 */
export function collectCodexCompletions(evidence) {
  const completions = [];
  for (const review of evidence.reviews ?? []) {
    if (!isBot(review) || !SUBMITTED_STATES.has(review.state)) continue;
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

/**
 * 裁定状況。**class ごと閉じる**: 現 head の Codex review に属する thread だけでなく、PR の全
 * review thread（代替レビューの指摘・対象不明の応答・第三者の thread を含む）を対象にし、
 * 「resolve 済みで、信頼済み人間（OWNER / MEMBER / COLLABORATOR、bot ではない）の返信がある」
 * 以外は裁定済みと数えない。`findings` は現 head の Codex review に属する thread 数。
 */
function adjudicationOf(evidence, headReviewIds) {
  const threads = (evidence.threads ?? []).filter((thread) => thread.comments.length > 0);
  const findings = threads.filter(
    (thread) =>
      isBot(thread.comments[0]) &&
      thread.comments.some((comment) => headReviewIds.has(comment.reviewId ?? '')),
  );
  const adjudicated = (comment) =>
    !isBot(comment) &&
    comment.authorType !== 'Bot' &&
    TRUSTED_ASSOCIATIONS.has(comment.authorAssociation ?? '');
  const unresolved = threads.filter((thread) => !thread.isResolved);
  const silent = threads.filter(
    (thread) => thread.isResolved && !thread.comments.some(adjudicated),
  );
  return { findings: findings.length, unresolved: unresolved.length, silent: silent.length };
}

/** 高リスクの固定差分契約（`[review-summary]`）の現 head 分。 */
export function readHighRiskSummary(evidence, headSha) {
  const parsed = (evidence.comments ?? [])
    .filter(
      (comment) =>
        !isBot(comment) &&
        comment.authorType !== 'Bot' &&
        TRUSTED_ASSOCIATIONS.has(comment.authorAssociation ?? '') &&
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
  return { status: parseHighRiskStatus(latest.status), entry: latest };
}

/**
 * `status:` 行を厳密に読む。許容する形は `reviewed` か `role=value` の comma 区切りで、
 * 全 role の値が正確に `reviewed` の時だけ satisfied。partial / stale / not-run / invalid が
 * 1 つでもあればその不足を返し、それ以外の値・形は unknown（Codex P2）。
 */
export function parseHighRiskStatus(raw) {
  const parts = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'unknown';
  // 許容する形は「単独の値」か「全要素が role=value」だけ。混在や重複の単独値は unknown（Codex P2）。
  const pairs = parts.map((part) => part.match(/^([\w-]+)=([\w-]+)$/));
  const allPairs = pairs.every(Boolean);
  const single = parts.length === 1 && !pairs[0] && /^[\w-]+$/.test(parts[0]);
  if (!allPairs && !single) return 'unknown';
  const values = allPairs ? pairs.map((pair) => pair[2]) : [parts[0]];
  if (values.some((value) => ['not-run', 'stale', 'invalid'].includes(value))) return 'stale';
  if (values.some((value) => value === 'partial')) return 'partial';
  if (values.every((value) => value === 'reviewed')) return 'satisfied';
  return 'unknown';
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
  // 対象不明の応答は、今回の head 切替後に投稿されたものだけを現 head の障害と数える（Codex P2）。
  const unknownTarget = completions.filter(
    (entry) =>
      entry.target === null &&
      (Number.isNaN(headAtOf(evidence)) || Date.parse(entry.at ?? '') >= headAtOf(evidence)),
  );
  // 依頼も信頼済み投稿者だけ数える（第三者の応答されない依頼で unknown へ落とされない。Codex P2）。
  const requests = (evidence.comments ?? []).filter(
    (comment) =>
      !isBot(comment) &&
      TRUSTED_ASSOCIATIONS.has(comment.authorAssociation ?? '') &&
      REVIEW_REQUEST_PATTERN.test(comment.body ?? ''),
  );
  // head へ切り替わった時刻（その head の最新の CI run 作成時刻。同じ SHA へ戻した場合も
  // synchronize が新しい run を作る）で依頼を照合する。commit metadata の日時は cherry-pick /
  // 古い commit の force-push で当てにならない（Codex P2、2 巡）。
  const headAt = headAtOf(evidence);
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
      reason = `No Codex response ${Math.round(waited / 60000)} min after the request; use only already-recorded review evidence if available`;
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

  // 追加レビューは停止中。既存の固定差分証跡は参考表示と過去証跡の互換性のために読むが、
  // 保護対象でも必須にしない。この判定から reviewer を起動することはない。
  const summary = readHighRiskSummary(evidence, headSha);
  let highRisk = null;
  if (base.protected) {
    highRisk = summary;
    highRisk.reason =
      highRisk.status === 'satisfied'
        ? 'Fixed-diff review summary matches this head'
        : `Fixed-diff review summary for this head is ${highRisk.status}`;
  }
  // 既存証跡を使う場合も裁定確認を通す: PR の全 thread が「信頼済み人間の返信つきで resolve」で
  // なければ pending-adjudication のまま。ここから新しい reviewer は起動しない。
  const existingSummaryEvidence = summary.status === 'satisfied';
  if (existingSummaryEvidence && ['unknown', 'failed'].includes(state)) {
    adjudication = adjudicationOf(evidence, new Set());
    if (adjudication.unresolved > 0 || adjudication.silent > 0) {
      state = 'pending-adjudication';
      reason = `${adjudication.unresolved + adjudication.silent} thread(s) not adjudicated by a trusted human reply`;
    } else {
      state = 'complete';
      reason = `Existing fixed-diff review evidence recorded for ${headSha.slice(0, 9)} (Codex: ${reason})`;
    }
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

  // blocked = 自動では前へ進まない状態（無応答 / 失敗 / 未裁定 / 対象不明）。
  // pending = まだ行うべき手順が残っている状態（未依頼 / 依頼中 / stale）。
  const stateBlocked = ['unknown', 'failed', 'pending-adjudication'].includes(state);
  const verdict = stateBlocked ? 'blocked' : state === 'complete' ? 'satisfied' : 'pending';
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
    lines.push(
      `Optional fixed-diff evidence: ${result.highRisk.status} — ${result.highRisk.reason}`,
    );
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
