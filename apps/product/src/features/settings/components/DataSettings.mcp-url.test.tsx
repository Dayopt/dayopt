import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  api: {
    useUtils: () => ({ userSettings: { getAnalyticsConsent: { setData: vi.fn() } } }),
    userSettings: {
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

import { DataSettings } from './DataSettings';

const MCP_SECTION_TITLE = 'settings.dataControls.mcp.title';

describe('McpApiSection deployment-bound MCP URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('productionではcanonical resource URIをそのまま表示する', () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_RESOURCE_URI', 'https://mcp.dayopt.app');
    render(<DataSettings />);

    expect(screen.getByText(MCP_SECTION_TITLE)).toBeInTheDocument();
    expect(screen.getByText('https://mcp.dayopt.app')).toBeInTheDocument();
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
});
