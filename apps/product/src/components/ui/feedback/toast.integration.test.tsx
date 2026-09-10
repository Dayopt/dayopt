/**
 * 実物の sonner を使って、クリックで消えるかを確かめる。
 *
 * sonner の消去は requestAnimationFrame を経由するため、Browser pane が非表示だと
 * rAF が止まって判定できない。jsdom で本物を描画して確かめる。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

const { Toaster } = await import('./toast');
const { toast } = await import('@/lib/toast');

describe('Toaster（実物の sonner）', () => {
  it('×で消える', async () => {
    render(<Toaster />);
    toast.success('保存しました');

    await screen.findByText('保存しました');
    const close = screen.getByRole('button', { name: 'close' });

    close.click();

    await waitFor(() => {
      expect(screen.queryByText('保存しました')).toBeNull();
    });
  });

  it('本体をクリックしても消えない（×だけが消す）', async () => {
    render(<Toaster />);
    toast.success('保存しました');

    const el = await screen.findByText('保存しました');
    (el.closest('[data-sonner-toast]') as HTMLElement).click();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByText('保存しました')).not.toBeNull();
  });
});
