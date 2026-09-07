import { ServiceError } from './errors';

/**
 * UIが分岐に使うことを許可したServiceError code。
 *
 * ここに無いcodeはclientへ載らず、UI側の分岐は既定枝へ落ちる。分岐を足す時は
 * 必ずここへ登録する（登録漏れは分岐を丸ごと殺す。#1937）。逆に、内部構成や
 * 失敗した内部commandが読み取れるcodeは登録せず、汎用エラー表示のままにする。
 */
const CLIENT_SAFE_SERVICE_CODES = new Set([
  // Auth: パスワード再認証の失敗理由を出し分ける（account 削除・メールアドレス変更）。
  // 生のメッセージは既に FORBIDDEN として client へ届いていた値（#1925）で、
  // code 経由に揃えるだけであり新規の情報開示ではない
  'INVALID_PASSWORD',
  // Timeblock: 競合・楽観ロックの解決手段を出し分ける
  'RETRYABLE_CONTENTION',
  'STALE_TARGET',
  'STALE_VERSION',
  'TEMPORARY_FAILURE',
  'TIME_OVERLAP',
  // Timeblock: 時刻規則（DT003 / DT005）の拒否。UI 側の写しを外しても汎用の
  // saveFailed へ退化しないよう、規則ごとの文言へ写像できるようにする（#2628）。
  // 規則そのものは公開仕様（MCP `constraints.get` が同じものを返す）なので、
  // これを載せても内部構成は漏れない
  'INVALID_TIME_RANGE',
  'RECORD_IN_FUTURE',
  // Timeblock: 型がその日に収まらない（DST で時計が飛ぶ日など）。他の日なら通る型が
  // その日だけ落ちるので、汎用の失敗と区別して原因を伝える必要がある（#2567）
  'TEMPLATE_DOES_NOT_FIT',
  // Billing: 支払い操作の失敗を「再試行 / やり直し / 削除中」へ畳む。いずれも
  // ユーザー自身の操作状態だけを表し、決済ベンダーの構成や内部commandの失敗
  // （BILLING_COMMAND_FAILED / BILLING_CONTRACT_INVALID / STRIPE_NOT_CONFIGURED 等）は含まない。
  'BILLING_ACCOUNT_CLOSING',
  'BILLING_CHECKOUT_NOT_AVAILABLE',
  'BILLING_OPERATION_CONFLICT',
  'BILLING_OPERATION_INVALIDATED',
  'BILLING_RECOVERY_EXHAUSTED',
  'BILLING_RESPONSE_EXPIRED',
]);

/** UIが分岐に使うことを許可したServiceError codeだけを公開する。 */
export function getClientSafeServiceCode(error: unknown): string | undefined {
  if (!(error instanceof ServiceError)) return undefined;
  return CLIENT_SAFE_SERVICE_CODES.has(error.code) ? error.code : undefined;
}
