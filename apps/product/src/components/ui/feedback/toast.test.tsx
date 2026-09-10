/**
 * Esc / クリックによる消去が「元に戻す」を巻き添えにしないこと。
 *
 * Inspector も Esc で閉じる（useInspectorKeyboard / useCalendarTimeblockKeyboard）ため、
 * 削除直後の 1 打で取り消し口まで消えると、戻す手段が 5 秒を待たずに失われる。
 * 一方でトースト本体のクリックは狙って押した操作なので、取り消し付きでも消す。
 *
 * ブラウザで確かめようとすると、ページが非表示の間 sonner がタイマーを止めるので
 * 結果が当てにならない。ここは handler の判断だけを直接確かめる。
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const onScreen = vi.hoisted(() => ({ value: [] as Array<{ action?: unknown }> }));
const dismiss = vi.hoisted(() => vi.fn());
const isMobile = vi.hoisted(() => ({ value: false }));

vi.mock('sonner', () => ({
  Toaster: () => <div data-testid="sonner-root" />,
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

  it('取り消し付きでもクリックでは消す（×を置かない以上、唯一の「今すぐ消す」導線）', () => {
    onScreen.value = UNDO_ON_SCREEN;
    render(<Toaster />);

    clickToastBody();

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('モバイルでは Esc もクリックも購読しない（スワイプで消す）', () => {
    isMobile.value = true;
    render(<Toaster />);

    pressEscape();
    clickToastBody();

    expect(dismiss).not.toHaveBeenCalled();
  });
});
