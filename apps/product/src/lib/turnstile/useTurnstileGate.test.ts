/**
 * Turnstile に到達できない利用者を無言で締め出さないこと。
 *
 * challenges.cloudflare.com が拡張機能 / 企業プロキシ / provider 障害で遮断されると
 * token が永久に来ない。token の有無だけで送信ボタンを無効にすると、理由の表示も
 * 回復手段も無いままログイン・サインアップ・パスワード再設定が全て不能になる。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ enabled: true }));
vi.mock('./config', () => ({
  isTurnstileEnabled: () => config.enabled,
  TURNSTILE_CONFIG: { SITE_KEY: 'test-site-key' },
}));

import { TURNSTILE_READY_TIMEOUT_MS, useTurnstileGate } from './useTurnstileGate';

beforeEach(() => {
  config.enabled = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTurnstileGate', () => {
  it('token が来るまでは送信を止める', () => {
    const { result } = renderHook(() => useTurnstileGate());

    expect(result.current.blocksSubmit).toBe(true);
    expect(result.current.unavailable).toBe(false);
  });

  it('token が来たら送信を通す', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onSuccess('token-a'));

    expect(result.current.token).toBe('token-a');
    expect(result.current.blocksSubmit).toBe(false);
  });

  it('widget が error を返したら送信を通し、到達不能を知らせる', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onError());

    expect(result.current.unavailable).toBe(true);
    expect(result.current.blocksSubmit).toBe(false);
  });

  // script 自体が遮断されると onError すら呼ばれない。時間でしか検出できない。
  it('沈黙したまま時間切れになったら送信を通す', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => {
      vi.advanceTimersByTime(TURNSTILE_READY_TIMEOUT_MS);
    });

    expect(result.current.unavailable).toBe(true);
    expect(result.current.blocksSubmit).toBe(false);
  });

  it('token が来ていれば時間切れにしない', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onSuccess('token-a'));
    act(() => {
      vi.advanceTimersByTime(TURNSTILE_READY_TIMEOUT_MS * 2);
    });

    expect(result.current.unavailable).toBe(false);
    expect(result.current.token).toBe('token-a');
  });

  it('expire したら token を捨てて再び待ち、沈黙すれば時間切れにする', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onSuccess('token-a'));
    act(() => result.current.onExpire());

    expect(result.current.token).toBeNull();
    expect(result.current.blocksSubmit).toBe(true);

    act(() => {
      vi.advanceTimersByTime(TURNSTILE_READY_TIMEOUT_MS);
    });

    expect(result.current.unavailable).toBe(true);
  });

  // 送信のたびに token は捨てる（単回使用）。捨てた直後に到達不能へ倒さない。
  it('reset すると token を捨てて widget を作り直し、待ち直す', () => {
    const { result } = renderHook(() => useTurnstileGate());
    const keyBefore = result.current.widgetKey;

    act(() => result.current.onError());
    act(() => result.current.reset());

    expect(result.current.token).toBeNull();
    expect(result.current.unavailable).toBe(false);
    expect(result.current.blocksSubmit).toBe(true);
    // key が変わることで widget が remount され、新しい challenge を引く
    expect(result.current.widgetKey).not.toBe(keyBefore);
  });

  it('site key が無い環境では送信を止めない', () => {
    config.enabled = false;
    const { result } = renderHook(() => useTurnstileGate());

    expect(result.current.enabled).toBe(false);
    expect(result.current.blocksSubmit).toBe(false);

    act(() => {
      vi.advanceTimersByTime(TURNSTILE_READY_TIMEOUT_MS);
    });

    expect(result.current.unavailable).toBe(false);
  });
});
