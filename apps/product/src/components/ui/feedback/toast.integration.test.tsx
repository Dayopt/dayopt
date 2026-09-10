/**
 * 実物の sonner を使って、クリックで消えるかを確かめる。
 *
 * ブラウザでは Browser pane が非表示だと sonner の内部処理が進まず判定できないので、
 * jsdom で本物を描画して確かめる。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

const { Toaster } = await import('./toast');
const { toast } = await import('@/lib/toast');

describe('Toaster（実物の sonner）', () => {
  it('本体クリックで消える', async () => {
    render(<Toaster />);
    toast.success('保存しました');

    const el = await screen.findByText('保存しました');
    const toastEl = el.closest('[data-sonner-toast]');
    expect(toastEl).not.toBeNull();

    (toastEl as HTMLElement).click();

    await waitFor(() => {
      expect(screen.queryByText('保存しました')).toBeNull();
    });
  });
});
