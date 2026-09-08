import { createServiceRoleClient } from '@/lib/supabase/oauth';
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';
import { ServiceError } from '@/lib/trpc/errors';

/**
 * セグメント（分析用の保存されたクエリ）の CRUD。
 *
 * セグメントは所属ではなく横断参照なので、`features/activities`（所属軸）ではなく
 * 分析側の feature に置く。保存するのは**アクティビティの集合だけ**で、期間・指標・
 * グルーピングは持たせない（#2162 §6-4。列を足さないこと自体がレポートビルダー化への
 * 制約になる）。
 *
 * 所有者整合は複合 FK（`(segment_id, user_id)` / `(activity_id, user_id)`）が担保する
 * ため、ここでは `.eq('user_id', userId)` のフィルタで足りる。他人のアクティビティを
 * 混ぜる insert は DB 側が FK 違反で弾く（`segment-schema.integration.test.ts` が固定）。
 */

type SegmentsServiceErrorCode =
  | 'FETCH_FAILED'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'DELETE_FAILED'
  | 'NOT_FOUND'
  | 'DUPLICATE_NAME'
  | 'INVALID_INPUT';

export class SegmentsServiceError extends ServiceError {
  constructor(code: SegmentsServiceErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'SegmentsServiceError';
  }
}

/** PostgreSQL の一意制約違反。同名セグメントの作成で返る。 */
const UNIQUE_VIOLATION = '23505';
/** PostgreSQL の FK 違反。他人のアクティビティを混ぜようとした時に返る。 */
const FOREIGN_KEY_VIOLATION = '23503';

function createDatabaseError(
  error: unknown,
  code: Extract<
    SegmentsServiceErrorCode,
    'FETCH_FAILED' | 'CREATE_FAILED' | 'UPDATE_FAILED' | 'DELETE_FAILED'
  >,
  message: string,
  operation: string,
): SegmentsServiceError {
  const original = captureUnexpectedDatabaseError(error, {
    feature: 'segments',
    operation,
  });
  return new SegmentsServiceError(code, message, { cause: original });
}

/** 呼び出し側が受け取るセグメント。`activityIds` の順序は名前順ではなく DB の返り順。 */
interface Segment {
  id: string;
  name: string;
  activityIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface PostgrestLikeError {
  code?: string;
}

function errorCodeOf(error: unknown): string | undefined {
  return (error as PostgrestLikeError | null)?.code;
}

class SegmentsService {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  /**
   * セグメント一覧をメンバーシップ込みで返す。
   *
   * メンバーが 0 件のセグメントも `activityIds: []` として返す。分析側が
   * 「今週の『深い仕事』は 0h」を過去比較として出せるようにするため、行ごと落とさない。
   */
  async list(options: { userId: string }): Promise<Segment[]> {
    const { data, error } = await this.supabase
      .from('segments')
      .select('id, name, created_at, updated_at, segment_activities(activity_id)')
      .eq('user_id', options.userId)
      .order('name', { ascending: true });

    if (error) {
      throw createDatabaseError(error, 'FETCH_FAILED', 'Failed to fetch segments', 'list_segments');
    }

    return data.map((row) => ({
      id: row.id,
      name: row.name,
      activityIds: row.segment_activities.map((m) => m.activity_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async create(options: {
    userId: string;
    name: string;
    activityIds: readonly string[];
  }): Promise<Segment> {
    const { data, error } = await createServiceRoleClient()
      .from('segments')
      .insert({ user_id: options.userId, name: options.name })
      .select('id, name, created_at, updated_at')
      .single();

    if (error) {
      if (errorCodeOf(error) === UNIQUE_VIOLATION) {
        throw new SegmentsServiceError('DUPLICATE_NAME', 'Segment name already exists');
      }
      throw createDatabaseError(
        error,
        'CREATE_FAILED',
        'Failed to create segment',
        'create_segment',
      );
    }

    try {
      await this.replaceMembers({
        userId: options.userId,
        segmentId: data.id,
        activityIds: options.activityIds,
      });
    } catch (error) {
      // メンバー登録に失敗したら、作ったばかりのセグメント行を巻き戻す。
      // 残すと「見えない 0 件セグメント」が名前を占有し、ユーザーが同じ名前で
      // 作り直そうとした時に DUPLICATE_NAME で詰む（PostgREST に跨る
      // トランザクションが無いため、補償削除で代替する）。
      const { error: cleanupError } = await this.supabase
        .from('segments')
        .delete()
        .eq('id', data.id)
        .eq('user_id', options.userId);
      if (cleanupError) {
        // 元の失敗を優先して throw するが、補償削除自体の失敗も黙殺しない。
        // 残すと幽霊セグメントが残存したまま気づけない（#2204 クロスレビュー P3-3）。
        captureUnexpectedDatabaseError(cleanupError, {
          feature: 'segments',
          operation: 'create_segment_rollback',
        });
      }
      throw error;
    }

    return {
      id: data.id,
      name: data.name,
      activityIds: [...options.activityIds],
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async rename(options: { userId: string; segmentId: string; name: string }): Promise<void> {
    const { data, error } = await createServiceRoleClient()
      .from('segments')
      .update({ name: options.name })
      .eq('id', options.segmentId)
      .eq('user_id', options.userId)
      .select('id')
      .maybeSingle();

    if (error) {
      if (errorCodeOf(error) === UNIQUE_VIOLATION) {
        throw new SegmentsServiceError('DUPLICATE_NAME', 'Segment name already exists');
      }
      throw createDatabaseError(
        error,
        'UPDATE_FAILED',
        'Failed to rename segment',
        'rename_segment',
      );
    }
    if (!data) {
      throw new SegmentsServiceError('NOT_FOUND', 'Segment not found');
    }
  }

  /**
   * メンバーを入れ替える。
   *
   * **追加を先に、削除を後に**行う。PostgREST の 2 リクエストは 1 トランザクションに
   * ならないため、削除→挿入の順にすると「挿入だけ失敗してセグメントが空になる」
   * データ消失が起きる。攻撃者は要らず、別タブでアクティビティを消した直後の
   * stale な id が 1 つ混じるだけで踏む。多行 INSERT は原子的なので、追加が失敗した
   * 時点では何も消えていない状態で止まる。
   *
   * 逆順（追加成功 → 削除失敗）の失敗は「余分なメンバーが残る」だけで、再実行すれば
   * 収束する。消えるより残る方に倒している。
   */
  async replaceMembers(options: {
    userId: string;
    segmentId: string;
    activityIds: readonly string[];
  }): Promise<void> {
    // 存在しない / 他人のセグメントを黙って no-op にしない（rename / remove と同じ意味論）。
    // ここで弾いておくと、後段の FK 違反は必ず activity 側だと確定できる。
    await this.assertOwnedSegment(options);

    const desired = new Set(options.activityIds);
    const current = new Set(await this.listMemberIds(options));

    const toAdd = [...desired].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !desired.has(id));

    if (toAdd.length > 0) {
      const { error } = await createServiceRoleClient()
        .from('segment_activities')
        .insert(
          toAdd.map((activityId) => ({
            user_id: options.userId,
            segment_id: options.segmentId,
            activity_id: activityId,
          })),
        );

      if (error) {
        // セグメント側は上で確認済みなので、この FK 違反は activity 側で確定する。
        if (errorCodeOf(error) === FOREIGN_KEY_VIOLATION) {
          throw new SegmentsServiceError('INVALID_INPUT', 'Unknown or unowned activity');
        }
        throw createDatabaseError(
          error,
          'UPDATE_FAILED',
          'Failed to add segment members',
          'replace_segment_members',
        );
      }
    }

    if (toRemove.length > 0) {
      const { error } = await this.supabase
        .from('segment_activities')
        .delete()
        .eq('segment_id', options.segmentId)
        .eq('user_id', options.userId)
        .in('activity_id', toRemove);

      if (error) {
        throw createDatabaseError(
          error,
          'UPDATE_FAILED',
          'Failed to remove segment members',
          'replace_segment_members',
        );
      }
    }
  }

  /** 自分が所有するセグメントであることを確認する。無ければ NOT_FOUND。 */
  private async assertOwnedSegment(options: { userId: string; segmentId: string }): Promise<void> {
    const { data, error } = await this.supabase
      .from('segments')
      .select('id')
      .eq('id', options.segmentId)
      .eq('user_id', options.userId)
      .maybeSingle();

    if (error) {
      throw createDatabaseError(error, 'FETCH_FAILED', 'Failed to load segment', 'load_segment');
    }
    if (!data) {
      throw new SegmentsServiceError('NOT_FOUND', 'Segment not found');
    }
  }

  private async listMemberIds(options: { userId: string; segmentId: string }): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('segment_activities')
      .select('activity_id')
      .eq('segment_id', options.segmentId)
      .eq('user_id', options.userId);

    if (error) {
      throw createDatabaseError(
        error,
        'FETCH_FAILED',
        'Failed to load segment members',
        'list_segment_members',
      );
    }
    return data.map((row) => row.activity_id);
  }

  /** セグメントを削除する。メンバーシップは CASCADE で消え、アクティビティ本体は残る。 */
  async remove(options: { userId: string; segmentId: string }): Promise<void> {
    const { data, error } = await this.supabase
      .from('segments')
      .delete()
      .eq('id', options.segmentId)
      .eq('user_id', options.userId)
      .select('id')
      .maybeSingle();

    if (error) {
      throw createDatabaseError(
        error,
        'DELETE_FAILED',
        'Failed to delete segment',
        'delete_segment',
      );
    }
    if (!data) {
      throw new SegmentsServiceError('NOT_FOUND', 'Segment not found');
    }
  }
}

export function createSegmentsService(supabase: SupabaseClient<Database>) {
  return new SegmentsService(supabase);
}
