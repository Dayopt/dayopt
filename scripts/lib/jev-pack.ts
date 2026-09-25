/**
 * Evaluation Pack の契約（#2827 方針更新 2026-09-19）。
 *
 * Jev を「lane 分類器」から「複数用途で再利用する semantic evaluation layer」へ広げる
 * ための境界。1 つの pack は **狭い意味判断の質問セット + 決定的な baseline + policy** の
 * 組で、adapter（`jev-adapter.ts`）・runner（`jev-pack-runner.ts`）はどの pack でも同じ。
 *
 * 固定した設計点:
 *
 * - **Annotation と Decision を分ける。** Annotation は Jev の生の推定（課金済み、
 *   cacheKey で失効管理）。Decision は trusted code の policy が合成した結果で、
 *   `policyVersion` は cacheKey に**入れない**。閾値や合成規則を変えても課金済みの
 *   注釈は生き残り、report 時に Decision だけ計算し直す。
 * - **baseline は必須。** 「コードが答えられる問題を Jev へ聞かない」（Phase 1 の
 *   negative result）を構造で強制する。pack は自分の決定的な代替を必ず持ち、
 *   metrics はそれとの比較で読む。
 * - **Decision は権限・必須レビュー・merge に接続しない。** picks は「候補」であって
 *   authority ではない。floor は Annotation も Decision も読まない code が持つ。
 * - **evidence は保存しない。** truth の導出にだけ使い（diff patch 等）、case file には
 *   `truth` の結果だけ残す。
 */
import {
  JEV_MAX_INPUT_BYTES,
  JEV_MAX_TOTAL_INPUT_BYTES,
  jevCacheKey,
  jevInputBytes,
  type JevAnnotation,
  type JevJsonValue,
  type JevQuestion,
  type JevRequest,
  type JevState,
} from './jev-adapter.ts';
import type { PrEvidence } from './jev-gh-prs.ts';

export const PACK_IDS = ['shadow-e1', 'skill-suggestion'] as const;
export type PackId = (typeof PACK_IDS)[number];

/**
 * pack ごとの有効・無効（#2827 の不変条件「各 pack は独立して無効化・撤去できる」）。
 *
 * `JEV_DISABLED=1` は adapter 全体の kill switch で、粒度が粗すぎる。事前登録した
 * Go 条件を満たさなかった pack を止めるには、**その pack だけ**送信を止められる必要がある。
 *
 * **CLI ではなくここに置く。** 同じ pack を送れる入口が複数ある（`pnpm jev:pack` と、
 * 保存先の互換のために残している `pnpm jev:shadow`）ので、表を片方の CLI が持つと
 * もう片方が無効化を迂回する。入口が増えても `assertPackEvaluationAllowed` を通す限り
 * 同じ表を見る。
 *
 * 止めるのは `evaluate`（課金と外部送信が起きる経路）だけにする。`collect` と `report` は
 * 通す — negative result を読み返せなくなると、止めた判断の根拠ごと失われるため。
 */
export const PACK_STATUS: Record<PackId, { status: 'active' | 'disabled'; reason?: string }> = {
  // Phase 1 の 8 問は、決定的な代替（protected-path-gate / 本文長）を上回らなかった。
  // 質問文の問題ではなく「コードが確定できることを推測させていた」設計の問題なので、
  // 質問セットを作り直すまで送信しない。集計済みの結果は report で読める。
  'shadow-e1': {
    status: 'disabled',
    reason: 'Phase 1 で決定的な baseline を上回らなかった（#2827 の 2026-09-19 の判定）',
  },
  'skill-suggestion': {
    status: 'disabled',
    reason:
      '#2852 の採用評価は未完了（2026-09-25）。holdout は 1/19 成功後に 503 provider_error が 3 件連続し停止。追加送信の明示承認まで evaluate を止める',
  },
};

/**
 * 送信前に呼ぶ。無効なら stderr へ出す文面を返し、有効なら null を返す。
 *
 * **credential の確認より先に呼ぶ。** 「key が無い」と「止めてある」を取り違えると、
 * 1Password の承認を取りに行ってから初めて止まっていたと分かる。
 */
export function assertPackEvaluationAllowed(packId: PackId): string | null {
  const entry = PACK_STATUS[packId];
  if (!entry || entry.status !== 'disabled') return null;
  return (
    `pack ${packId} は無効化されている: ${entry.reason ?? '(理由の記載なし)'}\n` +
    `collect / report は使える。再開するには jev-pack.ts の PACK_STATUS を戻す\n`
  );
}

export type PackSplit = 'tune' | 'holdout';

/** policy が合成した結果。Annotation とは別に保存する。 */
export type PackDecision = {
  policyVersion: string;
  /** Jev の注釈を使えたか、baseline へ落ちたか。 */
  source: 'jev' | 'baseline';
  /** 質問 ID → 判定。boolean 質問は true / false、choice は選んだ値。 */
  picks: Record<string, boolean | string>;
  /** 不確実帯に入った質問 ID。候補には出すが確度が低い印。 */
  uncertain: string[];
};

export type PackFacets = Record<string, string | number | null>;

/** collect が pack から受け取る評価候補。evidence は truth 用で保存しない。 */
export type PackCandidate<I, E> = {
  id: string;
  split: PackSplit;
  input: I;
  evidence: E;
  /** 層別・表示用の小さな値（prNumber、stateSource など）。 */
  facets: PackFacets;
};

export type PackSyntheticCase = {
  id: string;
  purpose: string;
  expectation: string;
  state: JevState;
};

export type PackCase<I, T> = {
  id: string;
  packId: string;
  split: PackSplit;
  collectionStatus: 'ready' | 'input_too_large';
  facets: PackFacets;
  purpose?: string;
  expectation?: string;
  /** 合成 case は input を持たない（state を直接持つ）。 */
  input: I | null;
  state: JevState;
  droppedSections: string[];
  truth: T | null;
  annotation: JevAnnotation | null;
  baseline: PackDecision | null;
  decision: PackDecision | null;
};

export type PackReport = { summary: JevJsonValue; markdown: string };

/**
 * method 記法で書く。property 記法だと strictFunctionTypes で `I` が反変になり、
 * registry の `AnyPack` へ `as never` 無しで入らない。
 */
export type EvaluationPack<I, T = null, E = I> = {
  id: string;
  /** 質問文を変えたら上げる。questionSetId に入るので cacheKey が変わる。 */
  questionVersion: string;
  /** policy（閾値・合成規則）を変えたら上げる。cacheKey には入らない。 */
  policyVersion: string;
  questions: Record<string, JevQuestion>;
  deriveCases(prs: readonly PrEvidence[]): PackCandidate<I, E>[];
  synthetic?: readonly PackSyntheticCase[];
  buildState(input: I): { state: JevState; dropped: string[] };
  /** 決定的な代替。必ず持つ。 */
  baseline(input: I): PackDecision;
  policy(
    annotation: JevAnnotation | null,
    input: I | null,
    baseline: PackDecision | null,
  ): PackDecision;
  truth?(evidence: E): T;
  metrics(cases: readonly PackCase<I, T>[]): PackReport;
};

export type AnyPack = EvaluationPack<unknown, unknown, unknown>;

export function packQuestionSetId(pack: Pick<AnyPack, 'id' | 'questionVersion'>): string {
  return `${pack.id}-${pack.questionVersion}`;
}

export function buildPackRequest(
  pack: Pick<AnyPack, 'id' | 'questionVersion' | 'questions'>,
  state: JevState,
): JevRequest {
  return { questionSetId: packQuestionSetId(pack), questions: pack.questions, state };
}

/**
 * 上限判定は raw の本文長ではなく **実 request の直列化結果**で行う
 * （`jev-shadow-truth.ts` の `exceedsInputBudget` と同じ理由）。
 *
 * adapter は「state + 最長 question」と「payload 全体」の 2 つを見るので、ここも両方見る。
 * 片方しか見ないと、質問数の多い pack で collect は `ready` と書くのに evaluate は必ず
 * abstain する（manifest の上限超過件数も嘘になる）。
 */
export function exceedsPackInputBudget(
  pack: Pick<AnyPack, 'id' | 'questionVersion' | 'questions'>,
  state: JevState,
): boolean {
  const { longest, total } = jevInputBytes(buildPackRequest(pack, state));
  return longest > JEV_MAX_INPUT_BYTES || total > JEV_MAX_TOTAL_INPUT_BYTES;
}

/**
 * annotation が**現在の request に対する**ものか。再収集で本文が変わった、質問セットを
 * 上げた、といった時に cacheKey がずれる。ずれた注釈は保存はしておく（evaluate が
 * cacheKey で送り直す）が、policy には渡さない。渡すと古い回答が `source: 'jev'` の
 * Decision として再採用され、metrics を汚す。
 */
export function isFreshAnnotation<I, T>(
  pack: Pick<AnyPack, 'id' | 'questionVersion' | 'questions'>,
  item: Pick<PackCase<I, T>, 'state' | 'annotation'>,
): boolean {
  return (
    item.annotation !== null &&
    item.annotation.cacheKey === jevCacheKey(buildPackRequest(pack, item.state))
  );
}

/** baseline と decision を（再）計算する。annotation には触れない。 */
export function decideCase<I, T>(
  pack: EvaluationPack<I, T, unknown>,
  item: PackCase<I, T>,
): PackCase<I, T> {
  const baseline = item.input === null ? null : pack.baseline(item.input);
  const annotation = isFreshAnnotation(pack, item) ? item.annotation : null;
  const decision = pack.policy(annotation, item.input, baseline);
  return { ...item, baseline, decision };
}
