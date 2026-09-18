'use client';

import { useCallback, useEffect, useState } from 'react';

import { isTurnstileEnabled } from './config';

/**
 * widget が「載る」までの上限。token が返るまでの時間ではない。
 *
 * challenges.cloudflare.com が拡張機能 / プロキシで遮断されると widget は
 * onError も呼ばずに沈黙するため、載らないことは時間でしか検出できない。
 * 一方で **載った後は何秒かかっても待つ**。managed widget は対話操作を求めることが
 * あり、スクリーンリーダー利用者や操作に時間のかかる利用者は数十秒かかる。そこで
 * 打ち切ると、解けるはずの人を到達不能扱いして無駄な失敗へ誘導する。
 */
export const TURNSTILE_LOAD_TIMEOUT_MS = 15_000;

interface TurnstileGate {
  /** site key があるか（無い環境では widget 自体を出さない） */
  enabled: boolean;
  /** 検証済み token。単回使用・短命なので送信のたびに捨てる */
  token: string | null;
  /** widget に到達できない（script 遮断 / provider 障害 / 非対応環境）と判定した */
  unavailable: boolean;
  /**
   * Cloudflare が対話を求めた（= widget が場所を取り始めた）。
   * `appearance: 'interaction-only'` では普段 widget の高さが 0 なので、
   * 余白を出すかどうかの判断にだけ使う。**表示の可否には使わない**
   * （false の側で widget を隠すと、対話を求められた利用者が challenge を
   * 見られず送信もできなくなる）。
   */
  interactive: boolean;
  /** 送信を止めるべきか。到達できない時は止めない（サーバーの本当のエラーまで通す） */
  blocksSubmit: boolean;
  /**
   * widget の React key。`reset()` でこれが変わり widget が作り直される。
   * imperative な `ref.reset()` を使わないのは、ref を持ち回ると利用側の render で
   * 読んだのと区別できず `react-hooks/refs` が止まるため。remount は新しい challenge を
   * 引くので、単回使用 token の作り直しとしては reset より強い。
   */
  widgetKey: number;
  /** widget が載ったことの通知。これが来たら以後 timeout では到達不能にしない */
  onWidgetLoad: () => void;
  onSuccess: (token: string) => void;
  onError: () => void;
  onExpire: () => void;
  onUnsupported: () => void;
  onBeforeInteractive: () => void;
  /** 送信後に token を捨てて widget を作り直す */
  reset: () => void;
}

/**
 * 認証フォームの Turnstile 状態を 1 箇所で持つ。
 *
 * token が来るまで送信ボタンを無効にする実装は、widget へ到達できない利用者を
 * 無言で締め出す（ボタンが永久に押せず、理由も出ない）。到達できないと判定したら
 * 送信を通し、サーバー側の captcha エラー（`auth.errors.captchaFailed`）を見せる。
 *
 * 到達できないと判定するのは次の 3 つだけ。**待たせている最中の widget は含めない。**
 * 1. 制限時間内に widget が載らなかった（script ごと遮断された）
 * 2. widget が error を返した
 * 3. 環境が非対応だと widget 自身が言った
 */
export function useTurnstileGate(): TurnstileGate {
  const enabled = isTurnstileEnabled();
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [widgetLoaded, setWidgetLoaded] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [widgetKey, setWidgetKey] = useState(0);

  useEffect(() => {
    if (!enabled || widgetLoaded || unavailable) return;

    const timer = setTimeout(() => setUnavailable(true), TURNSTILE_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [enabled, widgetLoaded, unavailable, widgetKey]);

  const onWidgetLoad = useCallback(() => {
    setWidgetLoaded(true);
    setUnavailable(false);
  }, []);

  const onSuccess = useCallback((next: string) => {
    setToken(next);
    setWidgetLoaded(true);
    setUnavailable(false);
  }, []);

  const onError = useCallback(() => {
    setToken(null);
    setUnavailable(true);
  }, []);

  const onUnsupported = useCallback(() => {
    setToken(null);
    setUnavailable(true);
  }, []);

  // 対話を求められたら widget が場所を取る。解けた後も widget が畳まれるまでの
  // 間があるので、ここで false へ戻さず `reset()` まで保持する（戻すと解いた瞬間に
  // レイアウトが跳ねる）。
  const onBeforeInteractive = useCallback(() => {
    setInteractive(true);
  }, []);

  // 期限切れは widget 自身が新しい challenge を出す。載っている事実は変わらないので
  // 待ち直しの対象にしない（ここで時間切れを再開すると対話中の利用者を打ち切る）。
  const onExpire = useCallback(() => {
    setToken(null);
  }, []);

  const reset = useCallback(() => {
    setToken(null);
    setUnavailable(false);
    setWidgetLoaded(false);
    setInteractive(false);
    setWidgetKey((key) => key + 1);
  }, []);

  return {
    enabled,
    token,
    unavailable,
    interactive,
    blocksSubmit: enabled && token === null && !unavailable,
    widgetKey,
    onWidgetLoad,
    onSuccess,
    onError,
    onExpire,
    onUnsupported,
    onBeforeInteractive,
    reset,
  };
}
