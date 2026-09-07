import {
  resolveTimeblockDestination,
  type TimeblockDestination,
} from '../domain/timeblock-destination';

export interface TimeblockDuplicateDraft {
  sourceId: string;
  kind: TimeblockDestination;
  title: string;
  note: string | null;
  activityId?: string | null | undefined;
  startAt: string;
  endAt: string;
}

interface CreateTimeblockDuplicateDraftArgs {
  sourceId: string;
  kind: TimeblockDestination;
  title: string;
  note: string | null;
  activityId?: string | null | undefined;
  startAt: Date;
  endAt: Date;
}

interface TimeblockDuplicateEditorValue {
  note: string;
  activityId?: string | null;
  startAt: Date;
  endAt: Date;
}

export type TimeblockDuplicateValidationReason = 'invalidRange' | 'recordRequiresPast';

interface TimeblockDuplicateCreateInput {
  title: string;
  note?: string | undefined;
  activityId?: string | undefined;
  start_at: string;
  end_at: string;
}

/** IDやPlan関係を含まない、独立複製用の下書きを作る。 */
export function createTimeblockDuplicateDraft({
  sourceId,
  kind,
  title,
  note,
  activityId,
  startAt,
  endAt,
}: CreateTimeblockDuplicateDraftArgs): TimeblockDuplicateDraft {
  return {
    sourceId,
    kind,
    title,
    note,
    activityId,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
  };
}

/**
 * 複製先の日時変更と Record の時間制約を検証する。
 *
 * Plan は時間軸のどこにでも置けるので時刻を問わない（2026-09-04 に DT004 を撤去済み）。
 * Record だけが「未来に終われない」（DT005）。
 */
export function getTimeblockDuplicateValidationReason(
  draft: TimeblockDuplicateDraft,
  value: TimeblockDuplicateEditorValue,
  now: Date = new Date(),
): TimeblockDuplicateValidationReason | null {
  if (value.startAt >= value.endAt) return 'invalidRange';

  if (draft.kind === 'record' && resolveTimeblockDestination(value.endAt, now) === 'plan') {
    return 'recordRequiresPast';
  }

  return null;
}

/** 複製下書きを既存create mutationの入力へ変換する。元IDとplan_idは含めない。 */
export function buildTimeblockDuplicateCreateInput(
  draft: TimeblockDuplicateDraft,
  value: TimeblockDuplicateEditorValue,
): TimeblockDuplicateCreateInput {
  const note = value.note.trim();

  return {
    title: draft.title,
    ...(note ? { note } : {}),
    ...(value.activityId ? { activityId: value.activityId } : {}),
    start_at: value.startAt.toISOString(),
    end_at: value.endAt.toISOString(),
  };
}
