/**
 * cron 同期ディスパッチャのスケジュール判定（overview.md §6-1 / §6-2-10）。
 *
 * 純粋関数のみ。DB / 時刻取得に依存しないので unit test で凍結できる。
 */

/**
 * due 判定の staleness 閾値。
 *
 * cron は 15 分毎に回る。`last_synced_at` がこの値より新しい接続は skip し、直前に
 * `syncNow` / connect で同期したばかりの接続を二重に叩かない。cron 間隔（15 分）より
 * わずかに短くして、通常の接続が毎回の cron で確実に due になるようにする。
 */
export const DUE_STALENESS_MS = 14 * 60 * 1000;

/**
 * 前進しなかった run がこの回数続いた接続は、cron の通常の due から外す（#2687）。
 * cron 15 分 × 6 ≒ 1.5 時間。`status` は変えない（provider / DB 障害でも積もるため、
 * 全ユーザーを再同意に追い込まない）。`syncNow` / 選択変更の同期が 1 回前進すれば 0 に戻る。
 */
export const SYNC_PAUSE_FAILURE_THRESHOLD = 6;

/**
 * due から外した接続を cron が再試行する間隔。外したまま放置すると provider / DB 障害が
 * 明けても誰かが手で同期するまで止まり続けるので、1 日 1 回は試す。
 */
export const PAUSED_CONNECTION_RETRY_MS = 24 * 60 * 60 * 1000;

/** 1 日を 15 分刻みで割ったスロット数（24h × 4）。cron 間隔と一致する。 */
const SLOTS_PER_DAY = 96;
const SLOT_LENGTH_MINUTES = 15;

/** UUID 文字列の決定的ハッシュ（djb2）。乱数を使わないので毎回同じスロットに割り当たる。 */
function hashConnectionId(connectionId: string): number {
  let hash = 5381;
  for (let index = 0; index < connectionId.length; index += 1) {
    // (hash * 33) ^ char。>>> 0 で 32bit 符号なしに畳む。
    hash = (((hash << 5) + hash) ^ connectionId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/** `now`（UTC）が属する 0..95 のスロット番号。 */
function slotOfNow(now: Date): number {
  const minutesSinceUtcMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();
  return Math.floor(minutesSinceUtcMidnight / SLOT_LENGTH_MINUTES) % SLOTS_PER_DAY;
}

/**
 * この接続を今回の cron 実行で full resync すべきか。
 *
 * 接続ごとにハッシュで 1 日 1 つのスロットを固定割り当てし、`now` がそのスロットの時だけ
 * true を返す。cron が 15 分毎に全 96 スロットを 1 周するので、各接続は 1 日にちょうど
 * 1 回だけ full resync に当たる。全接続を同時に full resync して Google の quota を焼く
 * のを避けつつ、増分 sync では取り込めない未来イベントを定期的に回収する（overview.md
 * §6-2-10 の穴を塞ぐ機構）。
 */
export function isDailyFullSyncSlot(connectionId: string, now: Date): boolean {
  return hashConnectionId(connectionId) % SLOTS_PER_DAY === slotOfNow(now);
}
