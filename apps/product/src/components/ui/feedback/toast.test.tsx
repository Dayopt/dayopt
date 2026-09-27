/**
 * トーストの消去の入口。
 *
 * 「今すぐ消す」は×へ集約する（Material の snackbar / sonner / Linear と同じ形）。
 * 本文クリックと Esc は持たない。隣にアクションがある面では意図が曖昧で、Esc は
 * Inspector を閉じる操作と一打が二役になるため。
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const isMobile = vi.hoisted(() => ({ value: false }));
const toasterProps = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toasterProps.value = props;
    return <div data-testid="sonner-root" />;
  },
  toast: {},
}));
vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => isMobile.value }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

const { Toaster } = await import('./toast');

describe('Toaster の消去', () => {
  beforeEach(() => {
    isMobile.value = false;
  });

  it('デスクトップは×を出す（唯一の「今すぐ消す」導線）', () => {
    render(<Toaster />);

    expect(toasterProps.value.closeButton).toBe(true);
  });

  it('モバイルは×を出さない（swipe が同じ役割を持つ）', () => {
    isMobile.value = true;
    render(<Toaster />);

    expect(toasterProps.value.closeButton).toBe(false);
  });
});
