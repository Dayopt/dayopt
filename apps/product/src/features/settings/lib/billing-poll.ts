import {
  dayoptPlanIds,
  getPlanIdForSubscriptionStatus,
  type SubscriptionStatus,
} from '@dayopt/billing';

/**
 * Stripe Checkout 成功復帰直後の有限ポーリング。
 *
 * `subscription_status` の更新は webhook 経由の非同期処理のため、Checkout 成功で
 * 復帰した直後は `billing.getOverview` を invalidate しても webhook 未到達で
 * 古い `free` が返りうる（issue #1887）。復帰直後だけ短い間隔で再取得し、
 * webhook 到達を待つ。
 */

/** ポーリング間隔（ミリ秒） */
export const BILLING_POLL_INTERVAL_MS = 2500;

/** ポーリングを打ち切るまでの最大経過時間（ミリ秒） */
export const BILLING_POLL_MAX_DURATION_MS = 30_000;

interface ShouldContinueBillingPollParams {
  /** ポーリング開始時刻（epoch ms）。null は非アクティブ（開始されていない） */
  startedAt: number | null;
  /** 直近取得した `subscription_status`（未取得時は undefined） */
  subscriptionStatus: SubscriptionStatus | null | undefined;
  /** テスト用に注入できる現在時刻（epoch ms）。省略時は `Date.now()` */
  now?: number;
}

/** Free相当の状態が最大待機時間を超えた時だけ、購入反映のtimeoutと判定する。 */
export function hasBillingPollTimedOut({
  startedAt,
  subscriptionStatus,
  now = Date.now(),
}: ShouldContinueBillingPollParams): boolean {
  return (
    startedAt !== null &&
    getPlanIdForSubscriptionStatus(subscriptionStatus) === dayoptPlanIds.free &&
    now - startedAt >= BILLING_POLL_MAX_DURATION_MS
  );
}

/**
 * ポーリングを続けるべきか判定する。
 *
 * 打ち切り条件は 2 つ（いずれか一方で停止）:
 * (a) `subscription_status` が Free 相当から抜けた（webhook 反映済み）
 * (b) 開始から {@link BILLING_POLL_MAX_DURATION_MS} を超えた（webhook 未達のまま打ち切り）
 */
export function shouldContinueBillingPoll({
  startedAt,
  subscriptionStatus,
  now = Date.now(),
}: ShouldContinueBillingPollParams): boolean {
  if (startedAt === null) return false;
  if (getPlanIdForSubscriptionStatus(subscriptionStatus) !== dayoptPlanIds.free) return false;
  return !hasBillingPollTimedOut({ startedAt, subscriptionStatus, now });
}
