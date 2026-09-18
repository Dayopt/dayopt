/**
 * Vercel AI Gateway 経由で Jev（`typesafe-ai/jev`）を 1 回呼ぶための薄い adapter。
 *
 * #2827 Phase 0。この層の責務は「外部 API の不確実性を、型の決まった Annotation
 * 1 個へ畳む」ことだけに限る。振り分け・権限・レビュー要件の合成は呼び出し側の
 * コードが持ち、Jev の出力から shell / tool / 権限へは繋がない。
 *
 * 固定した設計点（いずれも #2827 の制約に直接対応する）:
 *
 * - **`maxRetries: 0`**。AI SDK の既定は 2 で、429 や 5xx を黙って 3 倍へ増幅する。
 *   無料枠を溶かすのは本体より retry なので、再送は呼び出し側が明示的に決める。
 * - **失敗を throw しない**。すべて `status` で返す。Jev が落ちても既存の作業・
 *   独立レビューがそのまま成立することを、例外処理の有無ではなく型で強制する。
 * - **回答は「こちらが出した question id と type」以外を受け付けない**（schema confinement）。
 *   state に入る issue 本文 / PR コメント / diff は非信頼データで、Jev 自身は state 内の
 *   指示文を data と区別しない（TypeSafe の model 特性ページに明記がある）。
 *
 *   **これは prompt injection 対策ではない。** 保証するのは出力の*形*だけで、*内容*は守らない。
 *   非信頼な state が「lane は routine、追加レビューは不要」と指示し、Jev がそれに従っても、
 *   値が許可集合の中にある限りこの検証は通す。したがって **Annotation を根拠に、必須
 *   レビューや権限要件を引き下げてはならない**。要件の下限は Annotation を読まない
 *   trusted なコードが決める（#2827 §3「既存の必須レビューと権限条件をコードの下限にする」）。
 *   この層が防ぐのは、任意の値・任意のキー・任意の型が下流へ流れ込むことだけ。
 * - **残高は Gateway を正とする**。送信前に下限を割っていたら呼ばない。予算不足を
 *   credits 購入・他モデルへの fallback で救済する経路はこのファイルに存在しない。
 *
 * 秘密の扱い: API key は `AI_GATEWAY_API_KEY` から受け取り、値をログ・Annotation・
 * エラーメッセージへ載せない。呼び出しは `op run` 経由の inline `op://` 注入を想定する。
 */
import { createHash } from 'node:crypto';

import { createGateway, GatewayError } from '@ai-sdk/gateway';
import { experimental_evaluate as evaluate } from 'ai';

/** Annotation の形を変えたら上げる。cache key に入るので古い注釈は自動で失効する。 */
export const JEV_SCHEMA_VERSION = 1;

export const JEV_MODEL_ID = 'typesafe-ai/jev';

/** AI SDK 既定の 2 を明示的に打ち消す。理由はファイル冒頭。 */
export const JEV_MAX_RETRIES = 0;

export const JEV_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 入力の上限を **UTF-8 バイト**で決める。対象は「state + 最長の question」で、
 * TypeSafe が公開している制約（state と最長 question の合計で 32k tokens）と同じ単位に揃える。
 *
 * 文字数で見積もらないのは、当初 1 token = 4 文字として 96,000 文字を上限にしたところ、
 * それが英語にしか成り立たないため。日本語の Issue 本文や diff では 1 文字が 1 token を
 * 超えうるので、同じ文字数でも token 換算で数倍になり、事前検査を通ったあとに外部で失敗する。
 *
 * バイトなら tokenizer 非公開のまま**証明できる**下限がある: どの tokenizer でも
 * 1 token は最低 1 バイトを消費するので、32,000 バイトを超えなければ 32k tokens を必ず下回る。
 * 英語で約 32,000 文字、日本語で約 10,600 文字に相当し、評価用の state としては十分広い。
 *
 * 超えたら切り詰めずに abstain する（切り詰めた state で出た評価は、どの範囲を
 * 見ていないのかが後から復元できないため）。
 */
export const JEV_MAX_INPUT_BYTES = 32_000;

/** 1 request に載せる質問数の上限。公開仕様が無いので運用側で先に固定する。 */
export const JEV_MAX_QUESTIONS = 12;

/** 残高がこれを下回ったら送信しない（USD）。無料枠 $5 に対する保守的な床。 */
export const JEV_MIN_BALANCE_USD = 1;

export type JevStatus = 'evaluated' | 'abstained' | 'unavailable' | 'budget_exhausted';

/**
 * 固定 reason code。Jev に文章を書かせないための語彙で、表示文言はここから
 * テンプレートで組み立てる。
 */
export type JevReasonCode =
  | 'ok'
  | 'disabled'
  | 'missing_credentials'
  | 'invalid_request'
  | 'input_too_large'
  | 'balance_below_floor'
  | 'balance_unknown'
  | 'timeout'
  | 'rate_limited'
  | 'auth_failed'
  | 'customer_verification_required'
  | 'free_tier_restricted'
  | 'budget_exceeded'
  | 'insufficient_credits'
  | 'invalid_response'
  | 'provider_error';

export type JevQuestion =
  | { type: 'boolean'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

/**
 * state に載せてよい値。SDK の `EvaluationModelV4Input`（string | JSONObject |
 * JSONValue[]）と構造的に一致させる。`unknown` を許すと Date や class instance が
 * 混ざって、送信される JSON と hash 対象がずれる。
 */
export type JevJsonValue =
  string | number | boolean | null | JevJsonValue[] | { [key: string]: JevJsonValue };

export type JevState = string | { [key: string]: JevJsonValue } | JevJsonValue[];

/**
 * すべての回答が持つ 2 つの確信度。**別物なので混ぜない。**
 *
 * - `confidence` は TypeSafe が自分で計算して `providerMetadata.typesafe.confidence`
 *   に載せてくる値。閾値で振り分けるならこちらを使う。
 * - `topProbability` は分布の最大値で、こちらが導いた代替。2026-09-18 の smoke で
 *   両者は実際にずれた（choice の `lane` が分布 0.68 に対し confidence 0.52）。
 *   boolean には confidence が付かない（TypeSafe の仕様どおり、空で返る）ので、
 *   その場合の代替としてだけ使う。
 */
type JevConfidence = {
  confidence: number | null;
  topProbability: number | null;
};

export type JevAnswer =
  | ({ type: 'boolean'; probability: number } & JevConfidence)
  | ({
      type: 'choice';
      choice: string;
      probabilities: Record<string, number> | null;
    } & JevConfidence)
  | ({
      type: 'score';
      score: number;
      probabilities: Record<string, number> | null;
    } & JevConfidence);

export type JevCredits = { balance: number; totalUsed: number };

/**
 * 残高取得の結果。**失敗を「未取得」へ潰さない。**
 *
 * すべての例外を null にしていた頃は、key 失効（401）も rate limit（429）も timeout も
 * 「残高が読めない」＝予算切れ扱いになり、利用者が予算を確認して認証更新や待機を
 * 見落とす形になっていた。provider の失敗はそのまま渡して、分類は `classifyJevError`
 * 1 箇所で行う。
 */
export type JevCreditsResult =
  | { status: 'ok'; credits: JevCredits }
  /** 応答は得たが balance / total_used を数値として読めない */
  | { status: 'unreadable' }
  | { status: 'failed'; error: unknown };

export type JevAnnotation = {
  schemaVersion: number;
  status: JevStatus;
  reasonCode: JevReasonCode;
  /** 要求した model id。 */
  modelId: string;
  /** 実際に応答した model id（version 固定の確認用）。取れなければ null。 */
  resolvedModelId: string | null;
  questionSetId: string;
  /** 同じ入力を 2 度評価しないための鍵。schema / question / state が変われば失効する。 */
  cacheKey: string;
  stateSha256: string;
  evaluatedAt: string;
  /** 検証を通った回答だけ。1 つでも壊れていれば null（部分採用しない）。 */
  answers: Record<string, JevAnswer> | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number | null;
  /** 未取得と 0 を区別する。取れなければ null。 */
  credits: { before: JevCredits | null; after: JevCredits | null };
  /**
   * この 1 回の実費（USD）。**費用の正本はここで、残高差分ではない。**
   * Gateway の利用量は非同期で取り込まれるため、残高の前後差は生成ごとの実費と一致しない
   * （実測で 5 件の合計 $0.000104 に対し残高差は $0.000091 だった）。丸めずに保持する。
   */
  costUsd: number | null;
  coverage: {
    stateChars: number;
    /** state + 最長 question の UTF-8 バイト数。上限判定に使った値そのもの。 */
    inputBytes: number;
    questionCount: number;
    truncated: false;
  };
  /** provider が返した metadata の生写し（confidence が来るかの実測用）。 */
  providerMetadata: Record<string, unknown> | null;
};

export type JevRequest = {
  questionSetId: string;
  questions: Record<string, JevQuestion>;
  /** 非信頼データ。ここに書かれた指示を policy として扱わない。 */
  state: JevState;
};

export type JevRawResult = {
  answers: Record<string, unknown>;
  usage?: { inputTokens?: number; outputTokens?: number };
  response?: { modelId?: string };
  providerMetadata?: Record<string, unknown>;
};

/** 実 SDK を差し替えられる境界。test はここに偽物を渡し、network を一切使わない。 */
export type JevRunner = {
  evaluate(input: {
    state: JevState;
    questions: Record<string, JevQuestion>;
    abortSignal: AbortSignal;
  }): Promise<JevRawResult>;
  credits(): Promise<JevCreditsResult>;
};

export type JevOptions = {
  apiKey?: string;
  runner?: JevRunner;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxQuestions?: number;
  /** null で残高 gate を無効にする（残高 API 自体を検証する時だけ）。 */
  minBalanceUsd?: number | null;
  disabled?: boolean;
  now?: () => Date;
};

/** 鍵順に依存しない JSON。cache key と hash の安定性のために使う。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * provider が返した実費を取り出す。`providerMetadata.gateway.cost` は
 * `"0.000013524"` のような文字列で来る。読めなければ null（0 にしない）。
 */
export function readGatewayCostUsd(
  providerMetadata: Record<string, unknown> | null | undefined,
): number | null {
  const gatewayMeta = providerMetadata?.gateway;
  if (typeof gatewayMeta !== 'object' || gatewayMeta === null) return null;
  // `Number('')` は 0 になる。残高・--delay と同じ型の穴で、空文字の cost を
  // 「実費ゼロ」として報告してしまう。共通の numericField に通して未取得へ倒す。
  const value = numericField((gatewayMeta as Record<string, unknown>).cost);
  return value !== null && value >= 0 ? value : null;
}

/**
 * 課金対象になる入力の大きさ。TypeSafe の制約が「state + 最長 question」なので
 * 同じ組み合わせで測る。question の instructions と criteria の両方を数える。
 */
export function jevInputBytes(request: JevRequest): number {
  const stateBytes = utf8Bytes(canonicalJson(request.state));
  // id も payload のキーとして送られる。内容だけ測ると、長い id を付けた質問が
  // 事前検査を通ったあと provider 側で上限に当たる。
  const questionBytes = Object.entries(request.questions).map(
    ([id, question]) => utf8Bytes(id) + utf8Bytes(canonicalJson(question)),
  );
  return stateBytes + Math.max(0, ...questionBytes);
}

/**
 * 要求の静的検査。ネットワークを使わないので `pnpm jev:check` からも呼べる。
 * 返り値が空なら送ってよい。
 */
export function validateJevRequest(
  request: JevRequest,
  limits: { maxStateChars?: number; maxQuestions?: number } = {},
): string[] {
  const maxQuestions = limits.maxQuestions ?? JEV_MAX_QUESTIONS;
  const errors: string[] = [];
  if (!request.questionSetId.trim()) errors.push('questionSetId: 空');
  const ids = Object.keys(request.questions);
  if (ids.length === 0) errors.push('questions: 空');
  if (ids.length > maxQuestions)
    errors.push(`questions: ${ids.length} 件は上限 ${maxQuestions} 超`);
  for (const [id, question] of Object.entries(request.questions)) {
    if (!question.instructions.trim()) errors.push(`${id}.instructions: 空`);
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria);
      if (options.length < 2) errors.push(`${id}.criteria: choice は 2 件以上`);
      for (const option of options)
        if (!question.criteria[option]?.trim()) errors.push(`${id}.criteria.${option}: 空`);
    }
    if (question.type === 'score') {
      if (question.criteria.length < 2) errors.push(`${id}.criteria: score は 2 段以上`);
      question.criteria.forEach((level, index) => {
        if (!level.trim()) errors.push(`${id}.criteria[${index}]: 空`);
      });
    }
  }
  return errors;
}

/**
 * `providerMetadata.typesafe.confidence` を質問 ID → 数値で取り出す。
 *
 * 壊れていても評価そのものは捨てない。confidence は振り分けの補助であって回答では
 * なく、ここで annotation 全体を落とすと「答えは正しいのに使えない」状態を作る。
 * 読めない項目は null にして、呼び出し側が閾値を当てられないことを明示する。
 */
export function readTypesafeConfidence(
  providerMetadata: Record<string, unknown> | null | undefined,
): Record<string, number> {
  const typesafe = providerMetadata?.typesafe;
  if (typeof typesafe !== 'object' || typesafe === null) return {};
  const raw = (typesafe as Record<string, unknown>).confidence;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw))
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
      result[id] = value;
  return result;
}

function topProbabilityOf(probabilities: Record<string, number> | null): number | null {
  if (!probabilities) return null;
  const values = Object.values(probabilities);
  return values.length === 0 ? null : Math.max(...values);
}

/**
 * 分布の許容誤差。provider は桁を丸めて返すことがある（結果の `rounding` に桁数が載る）。
 * 3 択を小数 2 桁へ丸めた場合の最大ずれが 0.015 なので、その倍を取る。
 */
const PROBABILITY_TOLERANCE = 0.03;

/**
 * 分布の検証。**省略は許すが、あるなら完全で整合していることを要求する。**
 *
 * 部分的な分布を通していた頃は、`choice: 'routine'` に対して `{ frontier: 1 }` のような
 * 矛盾した応答が正規化され、回答は routine のまま `topProbability: 1` になった。
 * confidence が無い経路では、下流がそれを確信度の高い routine 判定として読む。
 */
function readProbabilities(raw: Record<string, unknown>, allowedKeys: Set<string>) {
  const value = raw.probabilities;
  if (value === undefined) return { ok: true as const, value: null };
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false as const, value: null };
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key)) return { ok: false as const, value: null };
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1)
      return { ok: false as const, value: null };
    result[key] = item;
  }
  // 欠けたキーがあれば分布として読めない（残りに確率を割り振れない）
  if (Object.keys(result).length !== allowedKeys.size) return { ok: false as const, value: null };
  const total = Object.values(result).reduce((sum, item) => sum + item, 0);
  if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) return { ok: false as const, value: null };
  return { ok: true as const, value: result };
}

/**
 * 1 問分の回答を、こちらが定義した形へ落とす。落とせなければ null。
 *
 * question id・type・choice の選択肢・score の段数はすべて要求側が決めた集合に閉じており、
 * model が別の値を返しても採用されない。**ただし守るのは形だけで、内容は守らない** —
 * 許可集合の中へ誘導された回答は素通りする。詳細はファイル冒頭の schema confinement の節。
 */
export function normalizeJevAnswer(
  question: JevQuestion,
  raw: unknown,
  confidence: number | null = null,
): JevAnswer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.type !== question.type) return null;

  if (question.type === 'boolean') {
    const probability = record.probability;
    if (typeof probability !== 'number' || !Number.isFinite(probability)) return null;
    if (probability < 0 || probability > 1) return null;
    return { type: 'boolean', probability, confidence, topProbability: null };
  }

  if (question.type === 'choice') {
    const choice = record.choice;
    const options = Object.keys(question.criteria);
    if (typeof choice !== 'string' || !options.includes(choice)) return null;
    const probabilities = readProbabilities(record, new Set(options));
    if (!probabilities.ok) return null;
    // SDK の契約上 choice は分布の最大値を取る option。食い違う応答は採用しない。
    if (probabilities.value) {
      const top = Math.max(...Object.values(probabilities.value));
      if (top - (probabilities.value[choice] ?? 0) > PROBABILITY_TOLERANCE) return null;
    }
    return {
      type: 'choice',
      choice,
      probabilities: probabilities.value,
      confidence,
      topProbability: topProbabilityOf(probabilities.value),
    };
  }

  const score = record.score;
  const lastIndex = question.criteria.length - 1;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score < 0 || score > lastIndex) return null;
  const levelKeys = new Set(question.criteria.map((_, index) => String(index)));
  const probabilities = readProbabilities(record, levelKeys);
  if (!probabilities.ok) return null;
  return {
    type: 'score',
    score,
    probabilities: probabilities.value,
    confidence,
    topProbability: topProbabilityOf(probabilities.value),
  };
}

function normalizeAnswers(
  questions: Record<string, JevQuestion>,
  raw: Record<string, unknown>,
  confidences: Record<string, number>,
): Record<string, JevAnswer> | null {
  const ids = Object.keys(questions);
  // 余分な id が来た時点で捨てる。部分採用すると「聞いていない判断」が混ざる。
  for (const id of Object.keys(raw)) if (!ids.includes(id)) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const id of ids) {
    const answer = normalizeJevAnswer(questions[id], raw[id], confidences[id] ?? null);
    if (!answer) return null;
    answers[id] = answer;
  }
  return answers;
}

type Failure = { status: JevStatus; reasonCode: JevReasonCode };

function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * 失敗の分類。budget 超過は AI SDK 7 で `GatewayInternalServerError` として
 * 出ることがある（Vercel の budgets ドキュメントに明記）ので、class 名だけで
 * 判定せず本文の `quota_for_entity_exceeded` も見る。
 */
export function classifyJevError(error: unknown): Failure {
  if (isAbort(error)) return { status: 'unavailable', reasonCode: 'timeout' };

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('quota_for_entity_exceeded'))
    return { status: 'budget_exhausted', reasonCode: 'budget_exceeded' };

  const statusCode = GatewayError.isInstance(error)
    ? error.statusCode
    : typeof (error as { statusCode?: unknown })?.statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : null;

  if (statusCode === 401) return { status: 'unavailable', reasonCode: 'auth_failed' };
  if (statusCode === 402) return { status: 'budget_exhausted', reasonCode: 'insufficient_credits' };
  if (statusCode === 429) return { status: 'unavailable', reasonCode: 'rate_limited' };
  if (statusCode === 403) {
    if (message.includes('customer_verification'))
      return { status: 'unavailable', reasonCode: 'customer_verification_required' };
    if (/free[ -]tier/i.test(message))
      return { status: 'unavailable', reasonCode: 'free_tier_restricted' };
    return { status: 'unavailable', reasonCode: 'auth_failed' };
  }
  return { status: 'unavailable', reasonCode: 'provider_error' };
}

/**
 * `"95.50"` のような文字列を数値へ。**`Number()` に直接渡さない。**
 * `Number(null)` と `Number('')` はどちらも 0 になるため、欠損した残高が
 * 「残高ゼロ」として通り、`balance_unknown` ではなく `balance_below_floor` に化ける。
 */
function numericField(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 読めなければ null（0 にしない）。呼び出し側は unreadable として扱う。 */
export function parseCredits(raw: { balance?: unknown; totalUsed?: unknown }): JevCredits | null {
  const balance = numericField(raw.balance);
  const totalUsed = numericField(raw.totalUsed);
  if (balance === null || totalUsed === null) return null;
  return { balance, totalUsed };
}

/**
 * 実 SDK を使う runner。`apiKey` は Gateway provider へ明示的に渡す（env への
 * 暗黙依存にすると、どの経路で秘密が入ったのかが呼び出し側から見えなくなる）。
 */
export function createJevRunner(options: { apiKey: string; timeoutMs: number }): JevRunner {
  // timeout は provider の fetch へ差し込む。`getCredits()` は abortSignal を
  // 受け取らないので、ここを抜くと残高取得だけが無期限に待ち、評価へ進む前に
  // 固まる（評価本体の signal は呼び出し側が渡すため、そちらだけ見ていると
  // 見落とす）。SDK が signal を付けてくる経路では両方を束ねる。
  const fetchWithTimeout: typeof fetch = (input, init) => {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal });
  };
  const gateway = createGateway({ apiKey: options.apiKey, fetch: fetchWithTimeout });
  return {
    async evaluate(input) {
      const result = await evaluate({
        model: gateway.evaluationModel(JEV_MODEL_ID),
        state: input.state,
        questions: input.questions,
        maxRetries: JEV_MAX_RETRIES,
        abortSignal: input.abortSignal,
      });
      return {
        answers: result.answers as Record<string, unknown>,
        usage: result.usage,
        response: { modelId: result.response?.modelId },
        providerMetadata: result.providerMetadata as Record<string, unknown> | undefined,
      };
    },
    async credits(): Promise<JevCreditsResult> {
      try {
        const credits = parseCredits(await gateway.getCredits());
        return credits ? { status: 'ok', credits } : { status: 'unreadable' };
      } catch (error) {
        // 401 / 429 / timeout をここで潰さない。呼び出し側が classifyJevError で分ける。
        return { status: 'failed', error };
      }
    },
  };
}

/**
 * 評価が終わったあとの残高取得。ここでの失敗は注釈を落とす理由にならないので、
 * 失敗も読めない応答も未取得（null）として扱う。事前取得とは扱いが違う。
 */
async function readCredits(runner: JevRunner): Promise<JevCredits | null> {
  const result = await runner.credits();
  return result.status === 'ok' ? result.credits : null;
}

export function jevCacheKey(request: JevRequest): string {
  return sha256(
    canonicalJson({
      schemaVersion: JEV_SCHEMA_VERSION,
      modelId: JEV_MODEL_ID,
      questionSetId: request.questionSetId,
      questions: request.questions,
      state: request.state,
    }),
  );
}

/**
 * Jev を 1 回呼び、Annotation を返す。**throw しない。**
 */
export async function evaluateWithJev(
  request: JevRequest,
  options: JevOptions = {},
): Promise<JevAnnotation> {
  const now = options.now ?? (() => new Date());
  const maxInputBytes = options.maxInputBytes ?? JEV_MAX_INPUT_BYTES;
  const maxQuestions = options.maxQuestions ?? JEV_MAX_QUESTIONS;
  const minBalanceUsd =
    options.minBalanceUsd === undefined ? JEV_MIN_BALANCE_USD : options.minBalanceUsd;
  const stateText = canonicalJson(request.state);
  const inputBytes = jevInputBytes(request);

  const base = {
    schemaVersion: JEV_SCHEMA_VERSION,
    modelId: JEV_MODEL_ID,
    resolvedModelId: null,
    questionSetId: request.questionSetId,
    cacheKey: jevCacheKey(request),
    stateSha256: sha256(stateText),
    evaluatedAt: now().toISOString(),
    answers: null,
    usage: { inputTokens: null, outputTokens: null },
    latencyMs: null,
    credits: { before: null, after: null },
    costUsd: null,
    coverage: {
      stateChars: stateText.length,
      inputBytes,
      questionCount: Object.keys(request.questions).length,
      truncated: false as const,
    },
    providerMetadata: null,
  } satisfies Omit<JevAnnotation, 'status' | 'reasonCode'>;

  const stop = (failure: Failure, extra: Partial<JevAnnotation> = {}): JevAnnotation => ({
    ...base,
    ...failure,
    ...extra,
  });

  const disabled = options.disabled ?? process.env.JEV_DISABLED === '1';
  if (disabled) return stop({ status: 'unavailable', reasonCode: 'disabled' });

  if (validateJevRequest(request, { maxQuestions }).length > 0)
    return stop({ status: 'abstained', reasonCode: 'invalid_request' });

  if (inputBytes > maxInputBytes)
    return stop({ status: 'abstained', reasonCode: 'input_too_large' });

  const apiKey = options.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? '';
  const runner =
    options.runner ??
    (apiKey
      ? createJevRunner({ apiKey, timeoutMs: options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS })
      : null);
  if (!runner) return stop({ status: 'unavailable', reasonCode: 'missing_credentials' });

  const beforeResult = await runner.credits();
  // 残高取得の失敗は予算問題ではない。401 なら auth_failed、429 なら rate_limited を返す。
  if (beforeResult.status === 'failed') return stop(classifyJevError(beforeResult.error));
  const before = beforeResult.status === 'ok' ? beforeResult.credits : null;
  if (minBalanceUsd !== null) {
    if (before === null) return stop({ status: 'budget_exhausted', reasonCode: 'balance_unknown' });
    if (before.balance < minBalanceUsd)
      return stop(
        { status: 'budget_exhausted', reasonCode: 'balance_below_floor' },
        {
          credits: { before, after: null },
        },
      );
  }

  const startedAt = Date.now();
  let raw: JevRawResult;
  try {
    raw = await runner.evaluate({
      state: request.state,
      questions: request.questions,
      abortSignal: AbortSignal.timeout(options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // timeout でも課金済みの可能性があるため、失敗側でも残高を取り直す。
    return stop(classifyJevError(error), {
      latencyMs: Date.now() - startedAt,
      credits: { before, after: await readCredits(runner) },
    });
  }

  const latencyMs = Date.now() - startedAt;
  const after = await readCredits(runner);
  const answers = normalizeAnswers(
    request.questions,
    raw.answers ?? {},
    readTypesafeConfidence(raw.providerMetadata),
  );
  const telemetry = {
    latencyMs,
    credits: { before, after },
    costUsd: readGatewayCostUsd(raw.providerMetadata),
    resolvedModelId: raw.response?.modelId ?? null,
    usage: {
      inputTokens: typeof raw.usage?.inputTokens === 'number' ? raw.usage.inputTokens : null,
      outputTokens: typeof raw.usage?.outputTokens === 'number' ? raw.usage.outputTokens : null,
    },
    providerMetadata: raw.providerMetadata ?? null,
  };

  if (!answers) return stop({ status: 'unavailable', reasonCode: 'invalid_response' }, telemetry);

  return { ...base, status: 'evaluated', reasonCode: 'ok', answers, ...telemetry };
}
