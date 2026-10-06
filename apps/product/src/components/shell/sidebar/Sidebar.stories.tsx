import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { PanelLeft } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useShellStore } from '@/lib/stores/useShellStore';
import { Button, HoverTooltip } from '@dayopt/components';

import { withWrapper } from '@dayopt/storybook/decorators';

import { AnimatedWidthPanel } from '../AnimatedWidthPanel';
import { Sidebar } from './Sidebar';

const MOCK_USER = { name: 'Demo User', email: 'demo@example.com', avatar: null };

// ── Mock: ブランド名 ──

function MockHeaderTitle() {
  return (
    <span className="text-foreground truncate text-sm font-medium tracking-tight">Dayopt</span>
  );
}

// ── Mock: サイドバーコンテンツ（SidebarContent の簡易版） ──

function MockSidebarContent() {
  return (
    <>
      <div className="p-4">
        <div className="bg-muted flex aspect-square w-full items-center justify-center rounded-lg">
          <span className="text-muted-foreground text-xs">Mini Calendar</span>
        </div>
      </div>
      <div className="space-y-1 px-2">
        {['Day', 'Week', 'Month'].map((label) => (
          <div
            key={label}
            className="text-muted-foreground hover:bg-state-hover rounded-lg px-4 py-2 text-sm"
          >
            {label}
          </div>
        ))}
      </div>
    </>
  );
}

/** サイドバーコンテナ。ブランド名 + 閉じるボタン、children スロット、検索 + UserMenu + ヘルプボタン。 */
const meta = {
  title: 'Product/Components/Shell/Sidebar/Container',
  component: Sidebar,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    user: MOCK_USER,
    headerTitle: <MockHeaderTitle />,
  },
  argTypes: {
    user: { control: false },
    headerTitle: { control: false },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// インタラクティブデモ（実コンポーネント使用）
// ---------------------------------------------------------------------------

function InteractiveDemo({ sidebarLabel }: { sidebarLabel?: string }) {
  const [isOpen, setIsOpen] = useState(true);

  // Zustand storeと同期
  useEffect(() => {
    if (isOpen) {
      useShellStore.setState({ sidebar: { open: true, width: 256 } });
    } else {
      useShellStore.setState({ sidebar: { open: false, width: 256 } });
    }
  }, [isOpen]);

  return (
    <div className="border-border flex h-[500px] w-[800px] overflow-hidden rounded-2xl border">
      {/* サイドバー（実コンポーネント） */}
      <AnimatedWidthPanel open={isOpen} width={256} className="h-full" innerClassName="h-full">
        <Sidebar
          user={MOCK_USER}
          headerTitle={<MockHeaderTitle />}
          {...(sidebarLabel ? { 'aria-label': sidebarLabel } : {})}
        >
          <MockSidebarContent />
        </Sidebar>
      </AnimatedWidthPanel>

      {/* メインコンテンツ */}
      <div className="bg-background flex flex-1 flex-col">
        <div className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-4">
          {!isOpen && (
            <HoverTooltip content="Open sidebar" side="bottom">
              <Button
                variant="ghost"
                icon
                className="size-8"
                onClick={() => setIsOpen(true)}
                aria-label="Open sidebar"
              >
                <PanelLeft className="size-4" />
              </Button>
            </HoverTooltip>
          )}
          <span className="text-muted-foreground text-sm">Header</span>
        </div>
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="bg-container text-muted-foreground rounded-lg p-6 text-center text-sm">
            Main Content
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** デフォルト状態。コンテンツスロット付き。 */
export const Default: Story = {
  args: {
    children: <MockSidebarContent />,
  },
  decorators: [withWrapper('h-[500px] w-64')],
};

/** コンテンツなし。children スロットが空の状態。 */
export const Empty: Story = {
  args: {
    children: (
      <div className="flex flex-1 items-center justify-center p-4">
        <span className="text-muted-foreground text-sm">No content</span>
      </div>
    ),
  },
  decorators: [withWrapper('h-[400px] w-64')],
};

/**
 * インタラクティブデモ。閉じるボタンでサイドバーが閉じ、ヘッダーの開くボタンで復元。
 *
 * 実装構成:
 * - ヘッダー: ブランド名 + PanelLeft閉じるボタン
 * - コンテンツ: composition layerから注入（children スロット）
 * - フッター: 検索ボタン + UserMenu + ヘルプボタン
 */
export const Interactive: StoryObj = {
  render: () => <InteractiveDemo />,
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  args: {
    children: <MockSidebarContent />,
  },
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <div>
        <p className="text-muted-foreground mb-2 text-xs">
          デフォルト状態（コンテンツスロット付き）
        </p>
        <div className="h-[500px] w-64">
          <Sidebar
            user={MOCK_USER}
            headerTitle={<MockHeaderTitle />}
            aria-label="サイドバー（デフォルト）"
          >
            <MockSidebarContent />
          </Sidebar>
        </div>
      </div>
      <div>
        <p className="text-muted-foreground mb-2 text-xs">
          コンテンツなし（children スロットが空の状態）
        </p>
        <div className="h-[400px] w-64">
          <Sidebar user={MOCK_USER} headerTitle={<MockHeaderTitle />} aria-label="サイドバー（空）">
            <div className="flex flex-1 items-center justify-center p-4">
              <span className="text-muted-foreground text-sm">No content</span>
            </div>
          </Sidebar>
        </div>
      </div>
      <div>
        <p className="text-muted-foreground mb-2 text-xs">インタラクティブデモ（開閉切り替え）</p>
        <InteractiveDemo sidebarLabel="サイドバー（インタラクティブ）" />
      </div>
    </div>
  ),
};
