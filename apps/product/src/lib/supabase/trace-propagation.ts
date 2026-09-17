/**
 * Supabase request への W3C trace context 伝播（#2728）
 *
 * Sentry 側の trace と Supabase の API Gateway / Edge Function logs を同じ
 * `trace_id` で突き合わせるための opt-in。次の 3 点が揃って初めて header が付く。
 * 1 つでも欠けると supabase-js は warn を出すだけで silent に no-op になる。
 *
 * 1. `import '@supabase/supabase-js/tracing'`（`src/instrumentation.ts` の Node 分岐）
 *    が OpenTelemetry の trace context extractor を globalThis へ登録している
 * 2. Sentry が W3C `traceparent` を書く（`sentry.server.config.ts` の
 *    `propagateTraceparent: true`。SDK の既定は false で `sentry-trace` しか書かない）
 * 3. Supabase client がこの option で opt-in している
 *
 * **Node runtime 専用。** Edge（`@sentry/vercel-edge`）と browser（`@sentry/browser`）は
 * OpenTelemetry の global propagator を登録しないため、同じ option を渡しても
 * extractor が空の carrier しか得られず header は付かない。
 * 経路ごとの対象 / 対象外は docs/engineering/infra.md を参照。
 *
 * 伝播先は supabase-js が Supabase の origin に限定する（`getDefaultPropagationTargets`）。
 * `respectSamplingDecision` は既定の true のままで、未 sample の trace には
 * `traceparent` だけが付き `tracestate` / `baggage` は落ちる（相関には十分）。
 */
export const SUPABASE_TRACE_PROPAGATION = { enabled: true } as const;
