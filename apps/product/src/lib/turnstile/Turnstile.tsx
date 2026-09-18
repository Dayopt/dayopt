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
  locale?: Locale;
  theme?: 'light' | 'dark' | 'auto';
}

export const Turnstile = forwardRef<TurnstileInstance, TurnstileProps>(function Turnstile(
  { onSuccess, onError, onExpire, onWidgetLoad, onUnsupported, locale = 'auto', theme = 'auto' },
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
      options={{ language: locale, theme }}
    />
  );
});
