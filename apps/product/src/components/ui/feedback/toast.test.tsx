/**
 * Esc / クリックによる消去が「元に戻す」を巻き添えにしないこと。
 *
 * Inspector も Esc で閉じる（useInspectorKeyboard / useCalendarTimeblockKeyboard）ため、
 * 削除直後の 1 打で取り消し口まで消えると、戻す手段が 5 秒を待たずに失われる。
 *
 * ブラウザで確かめようとすると、ページが非表示の間 sonner がタイマーを止めるので
 * 結果が当てにならない。ここは handler の判断だけを直接確かめる。
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const onScreen = vi.hoisted(() => ({ value: [] as Array<{ action?: unknown }> }));
const dismiss = vi.hoisted(() => vi.fn());
const isMobile = vi.hoisted(() => ({ value: false }));

const toasterProps = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toasterProps.value = props;
    return <div data-testid="sonner-root" />;
  },
  toast: { getToasts: () => onScreen.value, dismiss },
}));
vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => isMobile.value }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

const { Toaster } = await import('./toast');

const UNDO_ON_SCREEN = [{ action: { label: '元に戻す' } }];
const PLAIN_ON_SCREEN = [{ action: undefined }];

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

/** トースト本体のクリックを模す（handler は closest で判定する） */
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
    onScreen.value = PLAIN_ON_SCREEN;
    isMobile.value = false;
  });

  it('取り消しの無いトーストは Esc で消える', () => {
    render(<Toaster />);

    pressEscape();

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('取り消し付きは Esc で消さない（Inspector を閉じる 1 打で戻し口を失わせない）', () => {
    onScreen.value = UNDO_ON_SCREEN;
    render(<Toaster />);

    pressEscape();

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('取り消しの無いトーストはクリックで消える', () => {
    render(<Toaster />);

    clickToastBody();

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('取り消し付きはクリックでも消さない', () => {
    onScreen.value = UNDO_ON_SCREEN;
    render(<Toaster />);

    clickToastBody();

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('モバイルでは Esc もクリックも購読しない（スワイプで消す）', () => {
    isMobile.value = true;
    render(<Toaster />);

    pressEscape();
    clickToastBody();

    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe('Toaster の閉じるボタン', () => {
  beforeEach(() => {
    onScreen.value = PLAIN_ON_SCREEN;
  });

  it('デスクトップでは出す（Esc / クリックを取り消しに効かせない分の受け皿）', () => {
    isMobile.value = false;
    render(<Toaster />);

    expect(toasterProps.value.closeButton).toBe(true);
  });

  it('モバイルでは出さない（swipe があり、44px は本文を削る）', () => {
    isMobile.value = true;
    render(<Toaster />);

    expect(toasterProps.value.closeButton).toBe(false);
  });
});
