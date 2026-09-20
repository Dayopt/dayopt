/**
 * 「元に戻す」の猶予を後続トーストから守る規律。
 *
 * 同時表示は 1 枚なので、後から出したトーストが前のものを押しのける。取り消し付きが
 * その犠牲になると、5 秒を待たずに戻し口が消える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const onScreen = vi.hoisted(() => ({ value: [] as Array<{ action?: unknown }> }));
const sonnerSuccess = vi.hoisted(() => vi.fn());
const sonnerError = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: sonnerSuccess,
    error: sonnerError,
    loading: vi.fn(),
    message: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
    getHistory: vi.fn(),
    getToasts: () => onScreen.value,
  }),
}));

const { toast } = await import('./toast');

const UNDO = { action: { label: '元に戻す', onClick: () => undefined } };

describe('toast', () => {
  beforeEach(() => {
    onScreen.value = [];
    sonnerSuccess.mockClear();
    sonnerError.mockClear();
  });

  it('取り消し付きが出ている間、取り消しの無い success は出さない', () => {
    onScreen.value = [{ action: { label: '元に戻す' } }];

    toast.success('更新しました');

    expect(sonnerSuccess).not.toHaveBeenCalled();
  });

  it('取り消し付き同士は差し替える（新しい戻し口の方が有効）', () => {
    onScreen.value = [{ action: { label: '元に戻す' } }];

    toast.success('削除しました', UNDO);

    expect(sonnerSuccess).toHaveBeenCalledTimes(1);
  });

  it('取り消し付きが出ていても error は必ず出す（失敗は画面を見ても分からない）', () => {
    onScreen.value = [{ action: { label: '元に戻す' } }];

    toast.error('保存できませんでした');

    expect(sonnerError).toHaveBeenCalledTimes(1);
  });

  it('取り消しが出ていなければ success はそのまま出る', () => {
    toast.success('更新しました');

    expect(sonnerSuccess).toHaveBeenCalledTimes(1);
  });

  it('action の有無で duration を出し分ける', () => {
    toast.success('保存しました');
    expect(sonnerSuccess.mock.calls[0]?.[1]).toMatchObject({ duration: 3000 });

    sonnerSuccess.mockClear();
    toast.success('削除しました', UNDO);
    expect(sonnerSuccess.mock.calls[0]?.[1]).toMatchObject({ duration: 5000 });
  });
});
