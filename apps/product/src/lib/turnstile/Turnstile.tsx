'use client';

import { Turnstile as TurnstileWidget, type TurnstileInstance } from '@marsidev/react-turnstile';
import { forwardRef } from 'react';

import { isTurnstileEnabled, TURNSTILE_CONFIG } from './config';

type Locale = 'ja' | 'en' | 'auto';

interface TurnstileProps {
  onSuccess: (token: string) => void;
  onError?: () => void;
  onExpire?: () => void;
  /** widget が載った（script が届いた）。到達不能の判定を打ち切るのに使う */
  onWidgetLoad?: () => void;
  /** 環境が非対応だと widget 自身が言った */
  onUnsupported?: () => void;
  /** Cloudflare が対話を求める直前。widget が場所を取り始めるので余白を戻す */
  onBeforeInteractive?: () => void;
  locale?: Locale;
  theme?: 'light' | 'dark' | 'auto';
}

export const Turnstile = forwardRef<TurnstileInstance, TurnstileProps>(function Turnstile(
  {
    onSuccess,
    onError,
    onExpire,
    onWidgetLoad,
    onUnsupported,
    onBeforeInteractive,
    locale = 'auto',
    theme = 'auto',
  },
  ref,
) {
  if (!isTurnstileEnabled()) {
    return null;
  }

  return (
    <TurnstileWidget
      ref={ref}
      siteKey={TURNSTILE_CONFIG.SITE_KEY}
      onSuccess={onSuccess}
      onError={onError}
      onExpire={onExpire}
      // exactOptionalPropertyTypes 下では optional prop に undefined を渡せないため、
      // 渡された時だけ spread する
      {...(onWidgetLoad ? { onWidgetLoad: () => onWidgetLoad() } : {})}
      {...(onUnsupported ? { onUnsupported } : {})}
      {...(onBeforeInteractive ? { onBeforeInteractive } : {})}
      options={{
        language: locale,
        theme,
        /**
         * 通常は widget を出さず、Cloudflare が対話を求めた時だけ出す。
         *
         * bot 対策を弱める設定ではない。challenge の実行と token の取得は `always` と
         * 同じで、検証も従来どおり GoTrue 側で行われる。変わるのは「疑われていない
         * 利用者にチェックボックスを見せない」点だけで、疑われた利用者には従来と同じ
         * チェックボックスが出る（`invisible` widget と違い、解き直す経路を残す）。
         */
        appearance: 'interaction-only',
      }}
    />
  );
});
