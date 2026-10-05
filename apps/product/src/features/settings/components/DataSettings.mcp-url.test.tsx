import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => ({ userSettings: { getAnalyticsConsent: { setData: vi.fn() } } }),
    userSettings: {
      get: { useQuery: () => ({ data: undefined }) },
      getAnalyticsConsent: {
        useQuery: () => ({ data: { allowed: false }, isLoading: false, isError: false }),
      },
      setAnalyticsConsent: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
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

const MCP_SECTION_TITLE = 'settings.dataControls.mcp.title';

describe('McpApiSection deployment-bound MCP URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('productionではcanonical resource URIを表示し、未公開ガイドへリンクしない', () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_RESOURCE_URI', 'https://mcp.dayopt.app');
    render(<DataSettings />);

    expect(screen.getByText(MCP_SECTION_TITLE)).toBeInTheDocument();
    expect(screen.getByText('https://mcp.dayopt.app')).toBeInTheDocument();
    expect(screen.getByText('settings.dataControls.mcp.connectionGuide')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'settings.dataControls.mcp.guideLink' }),
    ).not.toBeInTheDocument();
  });

  it('Preview identityではbranch originの/mcp transportを表示する', () => {
    vi.stubEnv(
      'NEXT_PUBLIC_MCP_RESOURCE_URI',
      'https://product-git-codex-mcp-preview-dayopt.vercel.app',
    );
    render(<DataSettings />);

    // resource URI は origin のまま、接続 URL は Preview で実際に機能する
    // `<branch origin>/mcp`（filesystem route）を案内する。
    expect(
      screen.getByText('https://product-git-codex-mcp-preview-dayopt.vercel.app/mcp'),
    ).toBeInTheDocument();
    expect(screen.queryByText('https://mcp.dayopt.app')).not.toBeInTheDocument();
  });

  it('MCP資格のないdeploy（空文字）ではセクション自体を出さない', () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_RESOURCE_URI', '');
    render(<DataSettings />);

    expect(screen.queryByText(MCP_SECTION_TITLE)).not.toBeInTheDocument();
    // 他セクションは影響を受けない。
    expect(screen.getByText('settings.dataControls.export.title')).toBeInTheDocument();
  });
  it('書き込み完了まではコピー成功を通知しない', async () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_RESOURCE_URI', 'https://mcp.dayopt.app');
    const user = userEvent.setup();
    let complete!: () => void;
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render(<DataSettings />);

    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(write).toHaveBeenCalledWith('https://mcp.dayopt.app');
    const prematureCalls = vi.mocked(toast.success).mock.calls.length;
    await act(async () => {
      complete();
    });
    expect(prematureCalls).toBe(0);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('settings.dataControls.mcp.copied'),
    );
  });

  it('コピー拒否では失敗を通知し、再試行の成功だけを成功通知する', async () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_RESOURCE_URI', 'https://mcp.dayopt.app');
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    render(<DataSettings />);

    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.toast.copyFailed'));
    expect(toast.success).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
