import 'server-only';

/**
 * パスワード再認証（captcha 免除の service-role signInWithPassword）
 *
 * 呼び出しはアカウント削除・メールアドレス変更の2箇所（`user-service.ts`）。増やす場合は
 * 以下の契約と `docs/product/specs/auth.md` の保証境界を先に読むこと。
 *
 * ⚠ このモジュールは **captcha を意図的に免除している**（#1925）。
 *
 * - gateway を経た request を GoTrue が admin role として解釈するため、
 *   `verifyCaptcha` が skip される。これが免除の仕組みそのもの
 * - **この endpoint の将来の captcha 強化も、ここでは効かない**。
 *   Supabase の Bot Protection 設定を変えてもこの経路は影響を受けないので、
 *   captcha に依存した対策をここに期待しない
 * - なぜ captcha を足す方式（削除ダイアログに Turnstile を載せる）を採らなかったかは
 *   `docs/product/specs/auth.md` の設定画面の本人確認と保証境界を参照
 *
 * ## client の扱い（契約）
 *
 * supabase-js の client は `signInWithPassword` が成功した時点で auth state が切り替わり、
 * 以後の PostgREST / Storage 呼び出しが **service_role から当該ユーザー権限へ降格する**。
 * そのため:
 *
 * - client は**呼び出しごとに生成**する。module スコープや singleton に保持しない
 * - client を**返さない・外へ漏らさない・他の操作に使わない**
 *
 * これを破ると、warm container 上で以後の admin 操作が他ユーザーのトークンで走る。
 * なお検証後の `signOut` で session が消えると client は service_role へ戻るが、
 * 降格している窓が存在する事実は変わらないので、いずれにせよ関数外へ出さない。
 *
 * ## 依存
 *
 * `SUPABASE_SECRET_KEY` を gateway が service_role として扱うこと。opaque key は
 * apikey に送り、gateway が内部 JWT へ変換する。JWT 形式でないこと自体は captcha
 * 免除不可の根拠ではない。ただし SDK の通信試験だけでは hosted gateway と Auth の
 * 配備状態まで証明できないため、切替前に captcha 有効環境で正誤 password を検証する。
 * 免除が成立しない場合は既存 canary + unavailable で fail-closed にする。
 */

import { TRPCError } from '@trpc/server';

import { logger } from '@/lib/logger';
import { reauthRateLimit } from '@/lib/rate-limit/upstash';
import { captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

/** 再認証の用途。GoTrue 呼び出しの Sentry tag と rate limit の bucket 分離に使う */
type ReauthContext = 'account_deletion' | 'email_change';

/**
 * 再認証専用の rate limit を強制する。呼び出し側（`user-service.ts` の各メソッド）が
 * `verifyPasswordWithCaptchaBypass` の**直前**に明示的に呼ぶ。
 *
 * 目的は2つ:
 * 1. captcha 免除・副作用ゼロの `signInWithPassword` を、盗まれた session からの
 *    オンライン総当たりに使わせない（tRPC 既定の 300/min/user だけでは緩すぎる）
 * 2. GoTrue 側の IP 共有バケット（全ユーザー・全 context で共有）の消費を頭打ちにする
 *
 * bucket は `context` ごとに分離する（`${context}:${userId}` をキーにする）。同一 bucket
 * にすると、例えば email 変更でパスワードを打ち間違えたユーザーが、無関係の account 削除
 * まで fail-closed で巻き添えになる。
 *
 * `contact/server/router.ts` の `enforceContactRateLimit` と同型: Upstash 障害時は
 * `SERVICE_UNAVAILABLE`、超過時は `TOO_MANY_REQUESTS` を TRPCError として直接 throw する。
 * service 層内で throw しても `handleServiceError` は既存 TRPCError を素通しするため、
 * router の catch とそのまま整合する。
 */
export async function enforceReauthRateLimit(
  userId: string,
  context: ReauthContext,
): Promise<void> {
  if (!reauthRateLimit) return;

  let success: boolean;
  try {
    ({ success } = await reauthRateLimit.limit(`${context}:${userId}`));
  } catch (error) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Reauthentication rate-limit service is unavailable',
      cause: error,
    });
  }

  if (!success) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many reauthentication attempts. Please try again later.',
    });
  }
}

/**
 * alert を鳴らさない GoTrue error code。
 *
 * ユーザー起因・環境起因で正常に起こりうるものだけを列挙する。ここに無いものは
 * 構成故障として扱い canary を鳴らす（既定を fail-loud にする）。
 *
 * `lib/sentry` の `EXPECTED_AUTH_ERROR_CODES` は流用できない。あちらは
 * 「Sentry issue にしない」集合で、`captcha_failed` や `bad_jwt`（＝まさに検出したい
 * 構成故障）がユーザー起因の code と同居しているため。
 */
const NON_ALERTING_ERROR_CODES = new Set([
  'email_not_confirmed',
  'user_banned',
  'over_request_rate_limit',
]);

/** GoTrue の rate limit。サーバー呼び出しなので egress IP を全ユーザーで共有する点に注意 */
const RATE_LIMITED_STATUS = 429;

type PasswordReauthenticationResult =
  /** パスワードが一致した */
  | { outcome: 'verified' }
  /** ユーザーが入力したパスワードが違う */
  | { outcome: 'invalid_password' }
  /** 検証手段そのものが使えない（構成故障・レート制限など）。削除は通さない */
  | { outcome: 'unavailable' };

interface VerifyPasswordInput {
  /** server 側の session から取得したアドレス。クライアント入力を渡さないこと */
  email: string;
  password: string;
  /** Sentry tag の分岐に使う。呼び出し元を canary メッセージだけで判別できるようにする */
  context: ReauthContext;
}

/**
 * captcha を迂回してパスワードを検証する。
 *
 * rate limit は持たない（呼び出し側が `enforceReauthRateLimit` を先に呼ぶ設計。
 * この関数自体は「パスワードが合っているか」の判定に専念する）。
 */
export async function verifyPasswordWithCaptchaBypass({
  email,
  password,
  context,
}: VerifyPasswordInput): Promise<PasswordReauthenticationResult> {
  // 呼び出しごとに生成する。返さない・使い回さない（上記の契約）
  const adminClient = createServiceRoleClient();

  // observeAuthOperation では包まない。構成故障は下の captureUnexpectedError で
  // 1 本に集約し、同一事象で Sentry issue が二重に立つのを避ける
  const { error } = await adminClient.auth.signInWithPassword({ email, password });

  if (!error) {
    // 検証のためだけに発行された session を残さない。削除まで到達すれば CASCADE で
    // 消えるが、後段（beforeIdentityDeletion の contention 等）で中断すると
    // 有効な refresh token だけが孤児として残る。
    //
    // scope の明示は必須。省略時の既定は 'global' で、**ユーザーの全端末が強制
    // ログアウトされる**（削除が中断した場合、巻き添えでログアウトだけが起きる）
    //
    // auth-js の失敗は throw ではなく**戻り値の error** で来る（network 失敗も
    // AuthRetryableFetchError に畳まれる）。await の結果を捨てると本命の失敗経路が
    // 無言で消え、孤児 session が残っても観測できない
    try {
      const { error: signOutError } = await adminClient.auth.signOut({ scope: 'local' });
      if (signOutError) {
        logger.warn('Failed to revoke reauthentication session', signOutError.message);
      }
    } catch (cause) {
      // 後始末の失敗で削除は止めない
      logger.warn('Failed to revoke reauthentication session', cause);
    }
    return { outcome: 'verified' };
  }

  if (error.code === 'invalid_credentials') return { outcome: 'invalid_password' };

  const isNonAlerting =
    (error.code !== undefined && NON_ALERTING_ERROR_CODES.has(error.code)) ||
    error.status === RATE_LIMITED_STATUS;
  if (isNonAlerting) return { outcome: 'unavailable' };

  // ここに来るのは captcha_failed / bad_jwt / 未知の code。いずれも迂回が
  // 壊れたことを示すので alert に乗せる（captureUnexpectedError は
  // isExpectedAuthError を経由せず無条件に Sentry へ送る）。
  // feature/operation を context で分岐し、email 変更側の構成故障が
  // account 削除の alert に混入しないようにする（呼び出し元を canary から判別できる）
  captureUnexpectedError(new Error(`${context} reauthentication unavailable`, { cause: error }), {
    feature: context,
    operation: `${context}_reauthenticate`,
    source: 'captcha_bypass',
  });

  return { outcome: 'unavailable' };
}
