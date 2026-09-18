/**
 * Turnstile に到達できない利用者を無言で締め出さないこと。
 *
 * challenges.cloudflare.com が拡張機能 / 企業プロキシ / provider 障害で遮断されると
 * widget が載らない。token の有無だけで送信ボタンを無効にすると、理由の表示も
 * 回復手段も無いままログイン・サインアップ・パスワード再設定が全て不能になる。
 *
 * 同時に、**載った widget を待っている利用者を打ち切らない**こと。managed widget は
 * 対話操作を求めることがあり、そこで到達不能扱いにすると、解けるはずの人を
 * 失敗する送信へ誘導してしまう。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ enabled: true }));
vi.mock('./config', () => ({
  isTurnstileEnabled: () => config.enabled,
  TURNSTILE_CONFIG: { SITE_KEY: 'test-site-key' },
}));

import { TURNSTILE_LOAD_TIMEOUT_MS, useTurnstileGate } from './useTurnstileGate';

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

  it('環境が非対応なら送信を通す', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onUnsupported());

    expect(result.current.unavailable).toBe(true);
    expect(result.current.blocksSubmit).toBe(false);
  });

  // script ごと遮断されると onError すら呼ばれない。時間でしか検出できない。
  it('widget が載らないまま時間切れになったら送信を通す', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => {
      vi.advanceTimersByTime(TURNSTILE_LOAD_TIMEOUT_MS);
    });

    expect(result.current.unavailable).toBe(true);
    expect(result.current.blocksSubmit).toBe(false);
  });

  // managed widget は対話操作を求める。読み込めている以上、何秒かかっても待つ。
  it('widget が載っていれば、token 未取得のまま時間が経っても到達不能にしない', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onWidgetLoad());
    act(() => {
      vi.advanceTimersByTime(TURNSTILE_LOAD_TIMEOUT_MS * 10);
    });

    expect(result.current.unavailable).toBe(false);
    expect(result.current.blocksSubmit).toBe(true);
    expect(result.current.token).toBeNull();
  });

  it('token が来ていれば時間切れにしない', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onSuccess('token-a'));
    act(() => {
      vi.advanceTimersByTime(TURNSTILE_LOAD_TIMEOUT_MS * 2);
    });

    expect(result.current.unavailable).toBe(false);
    expect(result.current.token).toBe('token-a');
  });

  // 期限切れは widget 自身が次の challenge を出す。載っている事実は変わらない。
  it('expire したら token を捨てるが、待ち直しの時間切れは始めない', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onSuccess('token-a'));
    act(() => result.current.onExpire());

    expect(result.current.token).toBeNull();
    expect(result.current.blocksSubmit).toBe(true);

    act(() => {
      vi.advanceTimersByTime(TURNSTILE_LOAD_TIMEOUT_MS * 2);
    });

    expect(result.current.unavailable).toBe(false);
  });

  // 送信のたびに token は捨てる（単回使用）。widget も作り直すので載り直しを待つ。
  it('reset すると token を捨てて widget を作り直し、載り直しを待つ', () => {
    const { result } = renderHook(() => useTurnstileGate());

    act(() => result.current.onError());
    act(() => result.current.reset());

    expect(result.current.token).toBeNull();
    expect(result.current.unavailable).toBe(false);
    expect(result.current.blocksSubmit).toBe(true);
    expect(result.current.widgetKey).not.toBe(0);

    act(() => result.current.onWidgetLoad());
    act(() => {
      vi.advanceTimersByTime(TURNSTILE_LOAD_TIMEOUT_MS * 2);
    });

    expect(result.current.unavailable).toBe(false);
  });

  it('site key が無い環境では送信を止めない', () => {
    config.enabled = false;
    const { result } = renderHook(() => useTurnstileGate());

    expect(result.current.enabled).toBe(false);
    expect(result.current.blocksSubmit).toBe(false);

    act(() => {
      vi.advanceTimersByTime(TURNSTILE_LOAD_TIMEOUT_MS);
    });

    expect(result.current.unavailable).toBe(false);
  });
});
