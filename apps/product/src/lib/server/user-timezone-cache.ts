/**
 * ユーザータイムゾーンの短寿命キャッシュ（30秒 TTL）
 *
 * タイムブロック操作（高頻度 mutation）の getUserTimezone 呼び出しで DB ラウンドトリップ
 * を削減する目的。TTL が短いため、通常運用では設定変更から 30 秒以内に反映される。
 *
 * settings の timezone が更新された時は `invalidateUserTimezoneCache(userId)` で
 * 即時 invalidate して、stale な timezone で entry が作成される事故を防ぐ。
 *
 * サーバーレス環境では instance ごとの独立 cache になるため、厳密な一貫性には
 * 頼らない（cache miss した instance は DB を引く）。
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { databaseTables, type Database } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';

interface TzCacheEntry {
  timezone: string;
  expiresAt: number;
}

const tzCache = new Map<string, TzCacheEntry>();
const TZ_CACHE_TTL_MS = 30_000;
const TZ_CACHE_MAX_SIZE = 1000;

/**
 * user_settings から timezone を取得（cache 経由、失敗時は 'UTC' にフォールバック）
 */
export async function getUserTimezone(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<string> {
  const now = Date.now();
  const cached = tzCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.timezone;
  }

  const { data, error } = await supabase
    .from(databaseTables.userSettings)
    .select('timezone')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    captureUnexpectedDatabaseError(error, {
      feature: 'user_settings',
      operation: 'get_cached_user_timezone',
    });
  }
  const timezone = (data?.timezone as string | null | undefined) ?? 'UTC';

  tzCache.set(userId, { timezone, expiresAt: now + TZ_CACHE_TTL_MS });

  // cache 肥大化防止（サーバーレス環境では通常不要だが安全策）
  if (tzCache.size > TZ_CACHE_MAX_SIZE) {
    for (const [key, entry] of tzCache) {
      if (entry.expiresAt <= now) tzCache.delete(key);
    }
  }

  return timezone;
}

/**
 * ユーザーの timezone cache を即時無効化する。
 *
 * settings.timezone 更新 mutation 完了後に呼ぶことで、30 秒 TTL を待たずに
 * 新しい timezone が即座に反映される。
 */
export function invalidateUserTimezoneCache(userId: string): void {
  tzCache.delete(userId);
}
