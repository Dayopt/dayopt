/**
 * 認証メール送信の idempotency key 生成（#2803）。
 *
 * **なぜ index.ts から分離したか**: `index.ts` は module scope で `Deno.env.get` を呼ぶため
 * Node 側の test runner から import できない。ここは Deno API に一切触れない純関数だけを置き、
 * `scripts/__tests__/send-auth-email-idempotency.test.ts` から直接検証する
 * （先例は `confirm-url.ts` / `failure.ts`）。
 *
 * **なぜ必要か**: GoTrue は 503 / 429 を retryable として扱い、5 秒の総予算内で最大 3 回まで
 * 同じ hook を呼び直す。Resend への送信が成功した後にこちらが失敗応答を返すと、再試行で
 * 同じメールが二重配送される。`failure.ts` の `resolveSendAuthEmailStatus` はこれを避けるため
 * 「1 通目送信済みなら 503 を 500 へ降格して再試行を諦める」回避策を持っていた。key を付けた
 * 経路ではその降格が要らなくなる。
 */

/**
 * `email_change` は現アドレス宛と新アドレス宛の 2 通を送る。これらは同じ webhook 配送に
 * 属する**別の論理配送**なので、key の末尾で分離する（分離しないと 2 通目が 1 通目の
 * idempotency キャッシュに当たり、新アドレス宛が送られない）。
 */
export type AuthEmailRecipientRole = 'single' | 'current' | 'new';

/**
 * idempotency key に使える安定したイベント識別子を取り出す。
 *
 * Standard Webhooks 仕様では `webhook-id` は「その event に固有で、失敗した webhook が
 * 何度 retry されても同じ値」と定義されている。Supabase Auth hook はこの仕様の header を
 * 送るので、retry では同じ値・別のイベントでは別の値になる — これがまさに欲しい性質。
 *
 * **欠落時に乱数へフォールバックしない。** 毎回違う key は idempotency として無意味なうえ、
 * 「冪等になったつもり」で `resolveSendAuthEmailStatus` の降格を外すと、かえって二重配送を
 * 増やす。key を作れない時は `undefined` を返し、呼び出し側は従来の非冪等な経路のまま扱う。
 */
export function resolveWebhookEventId(headers: Record<string, string>): string | undefined {
  // Deno の Headers は小文字へ正規化して列挙されるが、この関数は plain object も受けるので
  // 呼び出し側の正規化に依存しない。
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'webhook-id') continue;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/** Resend の idempotency key 上限。超える key は provider に拒否される。 */
const MAX_KEY_LENGTH = 256;

/**
 * 1 通ごとの idempotency key を作る。
 *
 * 形: `auth/<webhook-id>/<email_action_type>/<recipient role>`
 *
 * **key に PII / secret を入れない。** 宛先 email・`token`・`token_hash`・本文はいずれも
 * 含めない。Resend 側に保存され、こちらの log にも載りうる値なので、識別子だけで構成する。
 *
 * 上限超過時は `undefined` を返す（切り詰めると別イベント同士が同じ key に潰れうるため、
 * 黙って短くするより key 無しで送る方が安全）。
 */
export function buildAuthEmailIdempotencyKey({
  eventId,
  emailActionType,
  recipientRole,
}: {
  eventId: string | undefined;
  emailActionType: string;
  recipientRole: AuthEmailRecipientRole;
}): string | undefined {
  if (!eventId) return undefined;

  const key = `auth/${eventId}/${emailActionType}/${recipientRole}`;
  return key.length <= MAX_KEY_LENGTH ? key : undefined;
}
