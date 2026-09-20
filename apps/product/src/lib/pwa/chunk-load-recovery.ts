/**
 * ChunkLoadError からの 1 回だけの自動復帰
 *
 * deploy で chunk hash が変わると、古いシェルを開いたままのタブは存在しない chunk を
 * 取りに行き `ChunkLoadError` / `Failed to fetch dynamically imported module` で落ちる。
 * 実体は「クライアントが古い」だけなので、リロードすれば解消する一過性の故障。
 *
 * ループ防止のため sessionStorage の flag で 1 タブ 1 回に制限する。flag が立った状態で
 * もう一度同じ error が来たら、リロードでは直らない本物の故障として扱い（flag は消して
 * 後日の別 incident では再びリロードできるようにする）呼び出し側の通常経路へ返す。
 */

/** リロード済みかどうかを記録する sessionStorage のキー。 */
const RELOAD_FLAG_KEY = 'dayopt:chunk-reload-attempted';

/** Dayopt が CacheStorage に作るキャッシュ名の接頭辞（`public/sw.js` と一致させる）。 */
const DAYOPT_CACHE_PREFIX = 'dayopt-';

/** chunk 取得失敗を表すメッセージ（bundler / ブラウザごとに文言が違う）。 */
const CHUNK_ERROR_MESSAGE_PATTERN =
  /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i;

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

interface ChunkLoadRecoveryDeps {
  storage?: StorageLike | undefined;
  reload?: (() => void) | undefined;
  clearCaches?: (() => Promise<void>) | undefined;
}

/**
 * Dayopt が作った CacheStorage のキャッシュを全て削除する（best-effort）。
 *
 * `useServiceWorker` の `clearCache` と、ChunkLoadError 復帰の両方から使う。
 */
export async function clearDayoptCaches(): Promise<void> {
  if (typeof caches === 'undefined') {
    return;
  }

  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith(DAYOPT_CACHE_PREFIX))
      .map((name) => caches.delete(name)),
  );
}

/** chunk の読み込み失敗に由来する error か。 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    // Error を継承しない throw でも name / message を持つことがある
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as { name?: unknown; message?: unknown };
    if (candidate.name === 'ChunkLoadError') {
      return true;
    }
    return (
      typeof candidate.message === 'string' && CHUNK_ERROR_MESSAGE_PATTERN.test(candidate.message)
    );
  }

  if (error.name === 'ChunkLoadError') {
    return true;
  }
  return CHUNK_ERROR_MESSAGE_PATTERN.test(error.message);
}

function resolveStorage(explicit: StorageLike | undefined): StorageLike | null {
  if (explicit) {
    return explicit;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    // Safari の private mode などで accessor 自体が throw する
    return null;
  }
}

/**
 * ChunkLoadError なら 1 度だけキャッシュを捨ててリロードする。
 *
 * @returns リロードを開始した（＝呼び出し側は capture を省いてよい）時のみ true
 */
export function attemptChunkLoadRecovery(
  error: unknown,
  deps: ChunkLoadRecoveryDeps = {},
): boolean {
  if (!isChunkLoadError(error)) {
    return false;
  }

  const storage = resolveStorage(deps.storage);
  if (!storage) {
    // flag を保持できない環境ではリロードループを防げないので復帰しない
    return false;
  }

  let alreadyAttempted: string | null;
  try {
    alreadyAttempted = storage.getItem(RELOAD_FLAG_KEY);
  } catch {
    return false;
  }

  if (alreadyAttempted !== null) {
    // リロードしても直らなかった。以後は通常の error 表示に任せ、
    // flag は消して後日の別 incident では再び 1 回リロードできるようにする
    try {
      storage.removeItem(RELOAD_FLAG_KEY);
    } catch {
      // flag を消せなくても致命的ではない
    }
    return false;
  }

  try {
    storage.setItem(RELOAD_FLAG_KEY, '1');
  } catch {
    return false;
  }

  const clearCaches = deps.clearCaches ?? clearDayoptCaches;
  void clearCaches().catch(() => {
    // キャッシュ削除は best-effort。失敗してもリロードは行う
  });

  const reload = deps.reload ?? (() => window.location.reload());
  reload();
  return true;
}
