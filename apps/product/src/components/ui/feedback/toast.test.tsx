/**
 * トーストの消去の入口。
 *
 * 「今すぐ消す」は×へ集約する（Material の snackbar / sonner / Linear と同じ形）。
 * 本文クリックと Esc は持たない。隣にアクションがある面では意図が曖昧で、Esc は
 * Inspector を閉じる操作と一打が二役になるため。
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dismiss = vi.hoisted(() => vi.fn());
const isMobile = vi.hoisted(() => ({ value: false }));
const toasterProps = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toasterProps.value = props;
    return <div data-testid="sonner-root" />;
  },
  toast: { dismiss },
}));
vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => isMobile.value }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

const { Toaster } = await import('./toast');

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

/** トースト本体のクリックを模す */
function clickToastBody() {
  const el = document.createElement('div');
  el.setAttribute('data-sonner-toast', '');
  document.body.appendChild(el);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  el.remove();
}

describe('Toaster の消去', () => {
  beforeEach(() => {
    dismiss.mockClear();
    isMobile.value = false;
  });

  it('Esc では消さない（Inspector を閉じる 1 打で取り消し口を失わせない）', () => {
    render(<Toaster />);

    pressEscape();

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('本文クリックでも消さない（アクションと意図が競合する）', () => {
    render(<Toaster />);

    clickToastBody();

    expect(dismiss).not.toHaveBeenCalled();
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
