/**
 * Toast ラッパー — 新仕様（ミニマル1行デザイン）準拠
 *
 * Duration ルール:
 * - action なし: 3秒で自動消去
 * - action あり: 5秒で自動消去（undo 猶予）
 *
 * description は仕様上廃止。安全策として wrapper でストリップ。
 *
 * 同時表示は 1 枚なので、後から出したトーストが前のものを押しのける。「元に戻す」を
 * 持つトーストがその犠牲になると、取り消しの猶予（5 秒）を待たずに戻し口が消える。
 * そこで **取り消し付きが出ている間は、取り消しの無い success を出さない**。
 * 移動や更新の結果はカレンダー上で見えるので、落としても情報は失われない。
 * error は落とさない — 失敗は画面を見ても分からないため、常に最新を優先する。
 *
 * @example
 * ```ts
 * import { toast } from '@/lib/toast';
 *
 * toast.success('保存しました');
 * toast.error('保存に失敗しました');
 * toast.success('削除しました', { action: { label: '元に戻す', onClick: restore } });
 * ```
 */
import { toast as sonnerToast, type ExternalToast } from 'sonner';

type TitleT = Parameters<typeof sonnerToast>[0];

const TOAST_DURATION = {
  default: 3_000,
  withAction: 5_000,
} as const;

/** action の有無に応じた duration を返す */
const getDuration = (data?: ExternalToast): number =>
  data?.action ? TOAST_DURATION.withAction : TOAST_DURATION.default;

/**
 * 「元に戻す」付きのトーストが表示中か。
 *
 * 表示の都合で呼び出し元の処理を止めない。ここが投げると、保存が成功しているのに
 * 続きの後始末（パネルを閉じる・画面遷移）が落ちる。取れない時は「出ていない」と
 * 見なして従来どおり出す（取り消しの保護が効かないだけで済む）。
 */
const hasUndoableToastOnScreen = (): boolean => {
  try {
    return sonnerToast
      .getToasts()
      .some((toastOnScreen) => 'action' in toastOnScreen && toastOnScreen.action != null);
  } catch {
    return false;
  }
};

/**
 * この success を出すと、表示中の「元に戻す」を押しのけてしまうか。
 * 自分も action を持つなら、より新しい取り消し口なので出してよい。
 */
const wouldHideUndo = (data?: ExternalToast): boolean =>
  !data?.action && hasUndoableToastOnScreen();

/** description をストリップする（仕様上廃止） */
const stripDescription = (data?: ExternalToast): ExternalToast | undefined => {
  if (!data) return data;
  const { description: _, ...rest } = data;
  return rest;
};

export const toast = Object.assign(
  (...args: Parameters<typeof sonnerToast>) =>
    sonnerToast(args[0], { duration: getDuration(args[1]), ...stripDescription(args[1]) }),
  {
    success: (message: TitleT, data?: ExternalToast) => {
      if (wouldHideUndo(data)) return;
      return sonnerToast.success(message, {
        duration: getDuration(data),
        ...stripDescription(data),
      });
    },
    error: (message: TitleT, data?: ExternalToast) =>
      sonnerToast.error(message, { duration: getDuration(data), ...stripDescription(data) }),
    loading: sonnerToast.loading,
    message: sonnerToast.message,
    promise: sonnerToast.promise,
    dismiss: sonnerToast.dismiss,
    custom: sonnerToast.custom,
    getHistory: sonnerToast.getHistory,
    getToasts: sonnerToast.getToasts,
  },
);
