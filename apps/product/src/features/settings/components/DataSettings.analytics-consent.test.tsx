import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_TELEMETRY_CONSENT_EVENT,
  BROWSER_TELEMETRY_CONSENT_STORAGE_KEY,
} from '@dayopt/observability';

const accountConsent = vi.hoisted(() => ({ mutateAsync: vi.fn(), setData: vi.fn() }));

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => ({
      userSettings: { getAnalyticsConsent: { setData: accountConsent.setData } },
    }),
    userSettings: {
      getAnalyticsConsent: {
        useQuery: () => ({ data: { allowed: false }, isLoading: false, isError: false }),
      },
      setAnalyticsConsent: {
        useMutation: () => ({ mutateAsync: accountConsent.mutateAsync, isPending: false }),
      },
    },
    user: {
      exportData: {
        useQuery: () => ({ refetch: vi.fn(), isLoading: false, isFetching: false }),
      },
      deleteBlocks: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      deleteAllData: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
    billing: {
      getOverview: {
        useQuery: () => ({
          data: { billingInfo: { subscriptionStatus: 'active' } },
          isLoading: false,
        }),
      },
    },
  },
}));

import { toast } from '@/lib/toast';

import { DataSettings } from './DataSettings';

const CONSENT_KEY = BROWSER_TELEMETRY_CONSENT_STORAGE_KEY;
const ANALYTICS_LABEL = 'settings.legal.cookies.current.analytics';
const ENABLED = 'settings.legal.cookies.current.enabled';
const DISABLED = 'settings.legal.cookies.current.disabled';
const UNSET = 'settings.legal.cookies.unset';
const REVOKE = 'settings.legal.cookies.revoke';
const ALLOW = 'settings.legal.cookies.allow';
const REVOKE_CONFIRM = 'settings.legal.cookies.revokeConfirmLabel';

function storeConsent(analytics: boolean, marketing = false) {
  window.localStorage.setItem(
    CONSENT_KEY,
    JSON.stringify({ necessary: true, analytics, marketing, timestamp: 1_700_000_000_000 }),
  );
}

function readConsent(): { analytics: boolean; marketing: boolean } | null {
  const raw = window.localStorage.getItem(CONSENT_KEY);
  return raw ? (JSON.parse(raw) as { analytics: boolean; marketing: boolean }) : null;
}

/**
 * 分析同意セクション — 保存済みの同意をサービス内から撤回・再許可できることを固定する（#2831）。
 *
 * 撤回を受け取る側（DeferredAnalytics / instrumentation-client）は別テストで担保済みなので、
 * ここでは「利用者の操作が保存値を変え、表示が他タブ由来の変更にも追従する」ことだけを見る。
 */
describe('AnalyticsConsentSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('保存済みの許可を「有効」として表示する', async () => {
    storeConsent(true);
    render(<DataSettings />);

    expect(await screen.findByText(ANALYTICS_LABEL)).toBeInTheDocument();
    expect(await screen.findByText(ENABLED)).toBeInTheDocument();
  });

  it('未選択のときは「未選択」を表示し、許可ボタンを出す', async () => {
    render(<DataSettings />);

    expect(await screen.findByText(UNSET)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ALLOW })).toBeInTheDocument();
  });

  it('撤回を確認すると analytics:false が保存され、表示が「無効」に変わる', async () => {
    const user = userEvent.setup();
    storeConsent(true);
    render(<DataSettings />);

    await user.click(await screen.findByRole('button', { name: REVOKE }));
    await user.click(await screen.findByRole('button', { name: REVOKE_CONFIRM }));

    await waitFor(() => expect(readConsent()?.analytics).toBe(false));
    expect(await screen.findByText(DISABLED)).toBeInTheDocument();
  });

  it('再許可では marketing を true にしない', async () => {
    const user = userEvent.setup();
    storeConsent(false);
    render(<DataSettings />);

    await user.click(await screen.findByRole('button', { name: ALLOW }));

    await waitFor(() => expect(readConsent()?.analytics).toBe(true));
    expect(readConsent()?.marketing).toBe(false);
  });

  it('別タブで撤回されると表示が追従する', async () => {
    storeConsent(true);
    render(<DataSettings />);
    expect(await screen.findByText(ENABLED)).toBeInTheDocument();

    // 別タブの書き込みは storage event としてだけ届く（CustomEvent は同一文書内のみ）。
    storeConsent(false);
    window.dispatchEvent(new StorageEvent('storage', { key: CONSENT_KEY }));

    expect(await screen.findByText(DISABLED)).toBeInTheDocument();
  });

  it('同一文書内のバナー操作（cookieConsentChanged）にも追従する', async () => {
    render(<DataSettings />);
    expect(await screen.findByText(UNSET)).toBeInTheDocument();

    storeConsent(true);
    window.dispatchEvent(
      new CustomEvent(BROWSER_TELEMETRY_CONSENT_EVENT, {
        detail: { necessary: true, analytics: true, marketing: false, timestamp: 1 },
      }),
    );

    expect(await screen.findByText(ENABLED)).toBeInTheDocument();
  });

  it('保存だけが失敗する環境では、撤回を成功扱いにせず確認ダイアログを閉じない', async () => {
    const user = userEvent.setup();
    storeConsent(true);
    render(<DataSettings />);

    // 容量超過やブラウザの保存ポリシーで「読めるが書けない」状態。
    // setCookieConsent / acceptNecessaryOnly は例外を握りつぶすので、
    // 呼べたこと自体を成功の根拠にできない。
    const realStorage = window.localStorage;
    const failingStorage = {
      getItem: (key: string) => realStorage.getItem(key),
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    const spy = vi
      .spyOn(window, 'localStorage', 'get')
      .mockReturnValue(failingStorage as unknown as Storage);

    try {
      await user.click(await screen.findByRole('button', { name: REVOKE }));
      await user.click(await screen.findByRole('button', { name: REVOKE_CONFIRM }));

      // 保存値は許可のまま = telemetry も止まっていないので、閉じない。
      expect(screen.getByRole('button', { name: REVOKE_CONFIRM })).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('settings.legal.cookies.saveFailed');
    } finally {
      spy.mockRestore();
    }

    expect(readConsent()?.analytics).toBe(true);
  });

  it('localStorage が使えない環境でも throw せず「未選択」を出す', async () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    try {
      render(<DataSettings />);
      expect(await screen.findByText(UNSET)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('AccountAnalyticsConsentSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves the account-wide permission only after an explicit click', async () => {
    const user = userEvent.setup();
    accountConsent.mutateAsync.mockResolvedValue({
      allowed: true,
      updatedAt: '2026-09-24T00:00:00Z',
    });
    render(<DataSettings />);

    expect(accountConsent.mutateAsync).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'settings.legal.cookies.account.allow' }));
    expect(accountConsent.mutateAsync).toHaveBeenCalledWith({ allowed: true });
    await waitFor(() =>
      expect(accountConsent.setData).toHaveBeenCalledWith(undefined, {
        allowed: true,
        updatedAt: '2026-09-24T00:00:00Z',
      }),
    );
  });

  it('does not present a failed account permission as saved', async () => {
    const user = userEvent.setup();
    accountConsent.mutateAsync.mockRejectedValue(new Error('network'));
    render(<DataSettings />);

    await user.click(screen.getByRole('button', { name: 'settings.legal.cookies.account.allow' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('settings.legal.cookies.account.saveFailed'),
    );
    expect(accountConsent.setData).not.toHaveBeenCalled();
  });
});
