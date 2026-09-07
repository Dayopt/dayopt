import type { Row } from './types';

export const publicPlanSelect =
  'id, user_id, activity_id, external_calendar_event_id, title, note, start_at, end_at, source, deleted_at, created_at, updated_at' as const;

export type PublicPlanRow = Pick<
  Row<'plans'>,
  | 'id'
  | 'user_id'
  | 'activity_id'
  | 'external_calendar_event_id'
  | 'title'
  | 'note'
  | 'start_at'
  | 'end_at'
  | 'source'
  | 'deleted_at'
  | 'created_at'
  | 'updated_at'
>;

export function toPublicPlanRow(row: Row<'plans'>): PublicPlanRow {
  return {
    id: row.id,
    user_id: row.user_id,
    activity_id: row.activity_id,
    external_calendar_event_id: row.external_calendar_event_id,
    title: row.title,
    note: row.note,
    start_at: row.start_at,
    end_at: row.end_at,
    source: row.source,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const publicRecordSelect =
  'id, user_id, activity_id, external_calendar_event_id, title, note, start_at, end_at, source, fulfillment, deleted_at, created_at, updated_at' as const;

export type PublicRecordRow = Pick<
  Row<'records'>,
  | 'id'
  | 'user_id'
  | 'activity_id'
  | 'external_calendar_event_id'
  | 'title'
  | 'note'
  | 'start_at'
  | 'end_at'
  | 'source'
  | 'fulfillment'
  | 'deleted_at'
  | 'created_at'
  | 'updated_at'
>;

export function toPublicRecordRow(row: Row<'records'>): PublicRecordRow {
  return {
    id: row.id,
    user_id: row.user_id,
    activity_id: row.activity_id,
    external_calendar_event_id: row.external_calendar_event_id,
    title: row.title,
    note: row.note,
    start_at: row.start_at,
    end_at: row.end_at,
    source: row.source,
    fulfillment: row.fulfillment,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const publicUserSettingsSelect =
  'id, user_id, timezone, time_format, week_starts_on, show_weekends, show_week_numbers, default_duration, default_view, hour_height_density, theme, personalization, preferred_locale, ical_feed_token, created_at, updated_at' as const;

export type PublicUserSettingsRow = Pick<
  Row<'user_settings'>,
  | 'id'
  | 'user_id'
  | 'timezone'
  | 'time_format'
  | 'week_starts_on'
  | 'show_weekends'
  | 'show_week_numbers'
  | 'default_duration'
  | 'default_view'
  | 'hour_height_density'
  | 'theme'
  | 'personalization'
  | 'preferred_locale'
  | 'ical_feed_token'
  | 'created_at'
  | 'updated_at'
>;
