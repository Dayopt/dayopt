'use client';

import type { ReactNode } from 'react';

import {
  Badge,
  Button,
  Checkbox,
  InlineBanner,
  Skeleton,
  type BadgeProps,
} from '@dayopt/components';
import { CalendarSync, Plus, RefreshCw, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { SectionCard } from '@/components/ui/display/SectionCard';
import { ErrorState } from '@/components/ui/feedback/ErrorState';

export type GoogleCalendarOption = {
  id: string;
  name: string | null;
  primary: boolean;
  selected: boolean;
};

export type GoogleCalendarConnectionViewProps = {
  email: string | null;
  lastSyncedLabel: string;
  statusLabel: string;
  statusVariant: BadgeProps['variant'];
  persistedError: string | null;
  needsReauth: boolean;
  reconnectAvailable: boolean;
  calendars: GoogleCalendarOption[];
  selectedCalendarIds: ReadonlySet<string>;
  calendarsLoading: boolean;
  calendarsError: boolean;
  applying: boolean;
  syncing: boolean;
  disconnecting: boolean;
  selectionDirty: boolean;
  onToggleCalendar: (calendarId: string, checked: boolean) => void;
  onRetryCalendars: () => void;
  onApply: () => void;
  onSync: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
};

type GoogleCalendarSettingsViewProps = {
  loading: boolean;
  error: boolean;
  availabilityLoading: boolean;
  available: boolean;
  hasConnections: boolean;
  onRetry: () => void;
  onConnect: () => void;
  children?: ReactNode;
};

export function GoogleCalendarSettingsView({
  loading,
  error,
  availabilityLoading,
  available,
  hasConnections,
  onRetry,
  onConnect,
  children,
}: GoogleCalendarSettingsViewProps) {
  const t = useTranslations('settings.integrations.googleCalendar');
  const connectLabel = hasConnections ? t('addAccount') : t('connect');

  return (
    <SectionCard
      title={t('title')}
      actions={
        <Button
          size="sm"
          onClick={onConnect}
          disabled={availabilityLoading || !available}
          loading={availabilityLoading}
          loadingText={t('checkingAvailability')}
        >
          <Plus className="size-4" />
          {connectLabel}
        </Button>
      }
    >
      {!availabilityLoading && !available ? (
        <p className="text-muted-foreground text-sm">{t('unavailable')}</p>
      ) : (
        <p className="text-muted-foreground mb-4 text-sm">{t('description')}</p>
      )}

      {loading ? (
        <div className="space-y-3 py-4" aria-label={t('loading')}>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <ErrorState title={t('loadError')} onRetry={onRetry} size="sm" />
      ) : hasConnections ? (
        <div className="mt-4 space-y-4">{children}</div>
      ) : available ? (
        <p className="text-muted-foreground py-4 text-sm">{t('empty')}</p>
      ) : null}
    </SectionCard>
  );
}

export function GoogleCalendarConnectionView({
  email,
  lastSyncedLabel,
  statusLabel,
  statusVariant,
  persistedError,
  needsReauth,
  reconnectAvailable,
  calendars,
  selectedCalendarIds,
  calendarsLoading,
  calendarsError,
  applying,
  syncing,
  disconnecting,
  selectionDirty,
  onToggleCalendar,
  onRetryCalendars,
  onApply,
  onSync,
  onReconnect,
  onDisconnect,
}: GoogleCalendarConnectionViewProps) {
  const t = useTranslations('settings.integrations.googleCalendar');

  return (
    <article className="border-border rounded-2xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{email ?? t('unknownAccount')}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('lastSync', { value: lastSyncedLabel })}
          </p>
        </div>
        <Badge variant={statusVariant}>{statusLabel}</Badge>
      </div>

      {needsReauth ? (
        <div className="mt-4">
          <InlineBanner
            visible
            message={persistedError ?? t('errors.reauthRequired')}
            action={{
              label: t('reconnect'),
              onClick: onReconnect,
              disabled: !reconnectAvailable,
            }}
          />
        </div>
      ) : persistedError ? (
        <div className="mt-4">
          <InlineBanner visible message={persistedError} />
        </div>
      ) : null}

      <div className="mt-4">
        <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          {t('calendars')}
        </p>
        {needsReauth ? (
          <p className="text-muted-foreground py-3 text-sm">{t('reconnectToChoose')}</p>
        ) : calendarsLoading ? (
          <div className="space-y-2 py-2" aria-label={t('loadingCalendars')}>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : calendarsError ? (
          <ErrorState title={t('calendarLoadError')} onRetry={onRetryCalendars} size="sm" />
        ) : calendars.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">{t('noCalendars')}</p>
        ) : (
          <div className="divide-border divide-y">
            {calendars.map((calendar) => {
              const label = calendar.name ?? t('unnamedCalendar');
              return (
                <label
                  key={calendar.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 py-2 text-sm"
                >
                  <Checkbox
                    checked={selectedCalendarIds.has(calendar.id)}
                    disabled={applying}
                    onCheckedChange={(checked) => onToggleCalendar(calendar.id, checked === true)}
                    aria-label={label}
                  />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {calendar.primary ? <Badge variant="outline">{t('primary')}</Badge> : null}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={onApply}
          disabled={needsReauth || calendarsLoading || calendarsError || !selectionDirty || syncing}
          loading={applying}
          loadingText={t('applying')}
        >
          {t('apply')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onSync}
          disabled={needsReauth || applying}
          loading={syncing}
          loadingText={t('syncing')}
        >
          <RefreshCw className="size-4" />
          {t('syncNow')}
        </Button>
        {needsReauth ? (
          <Button variant="outline" size="sm" onClick={onReconnect} disabled={!reconnectAvailable}>
            <CalendarSync className="size-4" />
            {t('reconnect')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={onDisconnect}
          disabled={disconnecting || applying || syncing}
          className="text-destructive"
        >
          <Unplug className="size-4" />
          {t('disconnect')}
        </Button>
      </div>
    </article>
  );
}
