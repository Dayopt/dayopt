'use client';

import { useCallback, useEffect, useState } from 'react';

import { isTurnstileEnabled } from './config';

/**
 * widget が token を返すまで待つ上限。これを過ぎたら「到達できない」と判定する。
 * challenges.cloudflare.com が拡張機能 / プロキシで遮断されると widget は
 * onError も呼ばずに沈黙するため、時間でしか検出できない。
 */
export const TURNSTILE_READY_TIMEOUT_MS = 15_000;

interface TurnstileGate {
  /** site key があるか（無い環境では widget 自体を出さない） */
  enabled: boolean;
  /** 検証済み token。単回使用・短命なので送信のたびに捨てる */
  token: string | null;
  /** widget に到達できない（script 遮断 / provider 障害）と判定した */
  unavailable: boolean;
  /** 送信を止めるべきか。到達できない時は止めない（サーバーの本当のエラーまで通す） */
  blocksSubmit: boolean;
  /**
   * widget の React key。`reset()` でこれが変わり widget が作り直される。
   * imperative な `ref.reset()` を使わないのは、ref を持ち回ると利用側の render で
   * 読んだのと区別できず `react-hooks/refs` が止まるため。remount は新しい challenge を
   * 引くので、単回使用 token の作り直しとしては reset より強い。
   */
  widgetKey: number;
  onSuccess: (token: string) => void;
  onError: () => void;
  onExpire: () => void;
  /** 送信後に token を捨てて widget を作り直す */
  reset: () => void;
}

/**
 * 認証フォームの Turnstile 状態を 1 箇所で持つ。
 *
 * token が来るまで送信ボタンを無効にする実装は、widget へ到達できない利用者を
 * 無言で締め出す（ボタンが永久に押せず、理由も出ない）。到達できないと判定したら
 * 送信を通し、サーバー側の captcha エラー（`auth.errors.captchaFailed`）を見せる。
 */
export function useTurnstileGate(): TurnstileGate {
  const enabled = isTurnstileEnabled();
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [widgetKey, setWidgetKey] = useState(0);

  useEffect(() => {
    if (!enabled || token !== null || unavailable) return;

    const timer = setTimeout(() => setUnavailable(true), TURNSTILE_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [enabled, token, unavailable, widgetKey]);

  const onSuccess = useCallback((next: string) => {
    setToken(next);
    setUnavailable(false);
  }, []);

  const onError = useCallback(() => {
    setToken(null);
    setUnavailable(true);
  }, []);

  const onExpire = useCallback(() => {
    setToken(null);
    setWidgetKey((key) => key + 1);
  }, []);

  const reset = useCallback(() => {
    setToken(null);
    setUnavailable(false);
    setWidgetKey((key) => key + 1);
  }, []);

  return {
    enabled,
    token,
    unavailable,
    blocksSubmit: enabled && token === null && !unavailable,
    widgetKey,
    onSuccess,
    onError,
    onExpire,
    reset,
  };
}
