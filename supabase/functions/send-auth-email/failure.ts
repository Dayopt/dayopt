/**
 * `send-auth-email` の失敗分類（#2682）。
 *
 * **なぜ index.ts から分離したか**: `index.ts` は module scope で `Deno.env.get` を呼ぶため
 * Node 側の test runner から import できない。ここは Deno API に一切触れない純関数だけを置き、
 * `scripts/__tests__/send-auth-email-failure-classification.test.ts` から直接検証する
 * （先例は `confirm-url.ts` / `scripts/__tests__/send-auth-email-confirm-url.test.ts`、#2616）。
 *
 * **HTTP status を分ける理由**: 従来は署名不一致・Resend 停止・Resend 4xx・render 失敗を
 * すべて 401 に畳んでいた。Resend の availability 失敗を GoTrue の再試行に載せるため 503、
 * render / Resend の拒否は 500、署名不一致だけ 401 のまま残す（401 は認証境界の失敗であり、
 * 攻撃者由来のノイズを Sentry Issues に入れないため capture もしない）。
 */

export type SendAuthEmailFailurePhase = 'verify' | 'render' | 'send';

export type SendAuthEmailFailureKind =
  'signature' | 'resend_unavailable' | 'resend_rejected' | 'render' | 'unknown';

export interface SendAuthEmailFailure {
  status: 401 | 500 | 503;
  kind: SendAuthEmailFailureKind;
  resendErrorName?: string;
  message: string;
}

// 宛先 email を Sentry / エラーレスポンスへ漏らさないための redaction。
// RFC 準拠の完全な email 判定ではなく、ログ・エラーメッセージに紛れ込みがちな
// 素朴な `local@domain.tld` 形を潰せれば十分（宛先は元々 to には含めていない）。
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Resend の error.name のうち、availability 起因（fetch failed / 過負荷 / quota 超過）と
// みなして 503（= GoTrue の再試行対象）に分類するもの。4xx 相当の拒否（validation_error 等）
// はここに含めず resend_rejected（500）へ落ちる。
const RESEND_UNAVAILABLE_NAMES = new Set([
  'application_error',
  'internal_server_error',
  'rate_limit_exceeded',
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
]);

function redactMessage(message: string): string {
  return message.replace(EMAIL_PATTERN, '[redacted-email]');
}

function toSafeMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return redactMessage(error.message);
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return redactMessage((error as { message: string }).message);
  }
  return redactMessage(String(error));
}

// `new Error()` 系の `name` は Resend の error code ではない。除外しないと send phase の
// 一般的な throw が `resend_rejected` / `resend_error: TypeError` として記録され、
// Sentry の tag が実態と食い違う（分類上の status はどちらも 500）。
const BUILTIN_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
]);

function resendErrorNameOf(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as { name?: unknown }).name === 'string'
  ) {
    const name = (error as { name: string }).name;
    return BUILTIN_ERROR_NAMES.has(name) ? undefined : name;
  }
  return undefined;
}

function isWebhookVerificationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'WebhookVerificationError'
  );
}

export function classifySendAuthEmailFailure(
  error: unknown,
  phase: SendAuthEmailFailurePhase,
): SendAuthEmailFailure {
  const message = toSafeMessage(error);

  if (phase === 'verify' || isWebhookVerificationError(error)) {
    return { status: 401, kind: 'signature', message };
  }

  if (phase === 'render') {
    return { status: 500, kind: 'render', message };
  }

  // phase === 'send'
  const resendErrorName = resendErrorNameOf(error);
  if (resendErrorName) {
    if (RESEND_UNAVAILABLE_NAMES.has(resendErrorName)) {
      return { status: 503, kind: 'resend_unavailable', resendErrorName, message };
    }
    return { status: 500, kind: 'resend_rejected', resendErrorName, message };
  }

  return { status: 500, kind: 'unknown', message };
}

/**
 * 実際に返す HTTP status を決める。
 *
 * GoTrue は 503 / 429 を retryable として扱い、5 秒の総予算内で最大 3 回まで同じ hook を
 * 呼び直す（Supabase Auth Hooks の仕様、2026-09-10 実測）。`email_change` は現アドレス宛 →
 * 新アドレス宛の順に 2 通送るため、2 通目の失敗で 503 を返すと再試行のたびに 1 通目が
 * 重複配送される。冪等でない状態からの再試行は害の方が大きいので non-retryable へ落とす。
 */
export function resolveSendAuthEmailStatus(
  failure: SendAuthEmailFailure,
  options: { firstEmailAlreadySent: boolean },
): SendAuthEmailFailure['status'] {
  if (failure.status === 503 && options.firstEmailAlreadySent) {
    return 500;
  }
  return failure.status;
}
