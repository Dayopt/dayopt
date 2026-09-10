/**
 * Edge Function 用の最小 Sentry capture（#2682）。
 *
 * Deno 用 Sentry SDK は import map に足していない（deno.json への依存追加は本 issue の
 * scope 外）。DSN の envelope 仕様は安定しており、SDK 無しでも `fetch` だけで送れるため、
 * 直接 POST する薄い実装にした。`SENTRY_DSN` は Supabase secret として未投入で、その場合は
 * 全操作が no-op になる（Preview では init しない設計と同じ帰結）。
 *
 * Deno API には触れていないので Node 側の vitest からそのまま import できる
 * （`scripts/__tests__/send-auth-email-failure-classification.test.ts`）。
 */

export interface EdgeFunctionEvent {
  functionName: string;
  message: string;
  level?: 'error' | 'warning';
  /** Sentry の environment。既定は 'production'（DSN は production にしか投入しない）。 */
  environment?: string;
  tags: Record<string, string>;
  extra?: Record<string, unknown>;
}

/** DSN を envelope 送信先の URL と public key に分解する。不正な形式なら null。 */
export function parseSentryDsn(dsn: string): { envelopeUrl: string; publicKey: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return null;
  }

  const publicKey = parsed.username;
  const projectId = parsed.pathname.replace(/^\//, '');
  if (!publicKey || !projectId || !parsed.host) return null;

  return {
    envelopeUrl: `${parsed.protocol}//${parsed.host}/api/${projectId}/envelope/`,
    publicKey,
  };
}

function randomEventId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Sentry envelope（header line + item header line + event line）を組み立てる。純関数。 */
export function buildSentryEnvelope(
  dsn: string,
  event: EdgeFunctionEvent,
  now: Date = new Date(),
): { url: string; body: string; headers: Record<string, string> } | null {
  const parsed = parseSentryDsn(dsn);
  if (!parsed) return null;

  const eventId = randomEventId();
  const sentAt = now.toISOString();

  const envelopeHeader = { event_id: eventId, sent_at: sentAt, dsn };
  const itemHeader = { type: 'event' };
  const eventPayload = {
    event_id: eventId,
    timestamp: sentAt,
    platform: 'javascript',
    level: event.level ?? 'error',
    logger: 'edge-function',
    // environment を載せないと Sentry の既定ビュー（environment 絞り込み）から漏れる。
    environment: event.environment ?? 'production',
    message: event.message,
    // `function` tag は呼び出し側の tags 指定と独立に必ず付与する。monitoring.md の月次確認
    // （`tags[function]:send-auth-email` 検索）が呼び出し側の tags 漏れに依存しないようにする。
    tags: { function: event.functionName, ...event.tags },
    extra: event.extra ?? {},
  };

  const body = [
    JSON.stringify(envelopeHeader),
    JSON.stringify(itemHeader),
    JSON.stringify(eventPayload),
  ].join('\n');

  return {
    url: parsed.envelopeUrl,
    body,
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=dayopt-edge/1.0`,
    },
  };
}

/**
 * Sentry への POST に許す時間の上限（ms）。
 *
 * Auth Hook は 1 回の invocation あたり 5 秒の総予算しか持たず、retryable な失敗では
 * その予算内で再試行まで行われる（Supabase Auth Hooks の仕様、2026-09-10 実測）。
 * capture のために hook 全体を timeout させると、観測のために可用性を下げることになる。
 * 送信は best-effort とし、上限を超えたら諦める。
 */
const CAPTURE_TIMEOUT_MS = 1000;

/**
 * DSN が無ければ no-op。envelope の構築・送信のどの段階で失敗しても例外は投げず、
 * function 名だけを添えて console.error に残す（呼び出し側の error path を壊さない）。
 */
export async function captureEdgeFunctionEvent(
  dsn: string | undefined,
  event: EdgeFunctionEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!dsn) return;

  try {
    const envelope = buildSentryEnvelope(dsn, event);
    if (!envelope) return;

    await fetchImpl(envelope.url, {
      method: 'POST',
      headers: envelope.headers,
      body: envelope.body,
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
  } catch {
    console.error('[sentry] capture failed', { functionName: event.functionName });
  }
}
