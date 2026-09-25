import { z } from 'zod';

/**
 * Google OAuth / OpenID Connect のレスポンス schema。
 *
 * 外部から来る値なので、repo の外部入力 parse の idiom（`api/csp-report/route.ts`）に倣って
 * 全 string に `.max()` を置く。googleapis SDK は入れず素の fetch + zod で扱う（overview.md §5-2）。
 */

/**
 * 旧・広い Calendar API scope。
 *
 * 新規の認可リクエストではもう要求しない（GCP 審査の最小権限要件、#1963）。ただし
 * 既に grant 済みの既存接続はこの scope のまま動き続けるため、`hasRequiredCalendarScopes`
 * の判定からは削除しない。削除条件は同関数の doc comment を参照。
 */
export const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** カレンダー一覧の取得（`calendarList.list`）に必要な最小 scope。 */
export const GOOGLE_CALENDAR_LIST_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly';

/** 選択済みカレンダーの予定取得（`events.list`）に必要な最小 scope。 */
export const GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.events.readonly';

/**
 * 認可リクエストで要求する scope。
 *
 * `openid` が必須。Google が `id_token` を返すのは OpenID Connect の認証リクエスト
 * （scope に `openid` を含むもの）に対してだけで、Calendar scope だけを要求すると
 * token レスポンスに `id_token` が入らない。接続の同定に使う `sub` はそこからしか
 * 取れないため、これが無いと connect が必ず失敗する。
 * `email` は表示用の `provider_account_email` のため。
 *
 * Calendar scope は narrow pair（`calendarList.list` + `events.list` の 2 本）に絞る。
 * `calendar.readonly` が追加で持つ権限（ACL・設定・任意カレンダーの freebusy 等）は
 * このアプリでは一つも使っていない（審査要件、docs/operations/google-oauth-verification.md
 * §narrow pair の対応状況 参照）。
 *
 * @see https://developers.google.com/identity/openid-connect/openid-connect#scope-param
 */
export const GOOGLE_AUTHORIZATION_SCOPES = [
  'openid',
  'email',
  GOOGLE_CALENDAR_LIST_READONLY_SCOPE,
  GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
] as const;

/** Google が id_token の `iss` に入れる 2 形式。片方だけ許すと本番でランダムに落ちる。 */
const GOOGLE_ID_TOKEN_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

/**
 * token endpoint のレスポンス。
 *
 * `refresh_token` は optional。`prompt=consent` を送るので通常は必ず返るが、返らない場合に
 * 既存行を壊さないための分岐が connection-service 側にある。
 */
export const googleTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096).optional(),
  expires_in: z.number().int().positive().optional(),
  token_type: z.string().max(64).optional(),
  scope: z.string().min(1).max(4096),
  id_token: z.string().min(1).max(8192),
});

export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

/**
 * id_token の payload。
 *
 * `sub` が接続の同定基準になる。Google は email を可変・再利用可と明示しているので、
 * 安定識別子は `sub` だけ。`provider_account_id` にはこれを入れ、email は表示用の
 * `provider_account_email` にしか入れない。
 */
export const googleIdTokenPayloadSchema = z.object({
  iss: z.enum(GOOGLE_ID_TOKEN_ISSUERS),
  aud: z.string().min(1).max(512),
  sub: z.string().min(1).max(255),
  exp: z.number().int().positive(),
  email: z.string().email().max(320).optional(),
});

export type GoogleIdTokenPayload = z.infer<typeof googleIdTokenPayloadSchema>;

/** start が cookie に載せる一時 state。callback で読み戻す。 */
export const connectFlowStateSchema = z.object({
  state: z.string().min(1).max(255),
  verifier: z.string().min(1).max(255),
  attemptId: z.string().uuid(),
  locale: z.string().min(1).max(16),
  userId: z.string().uuid(),
  reconnectConnectionId: z.string().uuid().optional(),
});

export type ConnectFlowState = z.infer<typeof connectFlowStateSchema>;
