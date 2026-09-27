'use client';

import { useMemo, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { ConfirmDialog } from '@/components/ui/overlays/confirm-dialog';
import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import { useHasMounted } from '@/lib/hooks/useHasMounted';
import { toast } from '@/lib/toast';
import { api } from '@/lib/trpc';

import {
  GoogleCalendarConnectionView,
  GoogleCalendarSettingsView,
  type GoogleCalendarOption,
} from './GoogleCalendarSettingsView';

type ConnectionSummary = {
  id: string;
  provider: string;
  provider_account_email: string | null;
  status: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
};

type SyncOutcome =
  | 'synced'
  | 'skipped_reauth_required'
  | 'reauth_required'
  | 'encryption_key_invalid'
  | 'partial_failure'
  | 'partial_timeout'
  | 'not_configured';

export function GoogleCalendarSettings() {
  const locale = useLocale();
  const hasMounted = useHasMounted();
  const origin = hasMounted ? window.location.origin : null;
  const connections = api.externalCalendar.listConnections.useQuery(undefined, {
    retry: false,
    refetchOnMount: 'always',
  });
  const availability = api.externalCalendar.getConnectionAvailability.useQuery(
    { origin: origin ?? 'https://invalid.local' },
    { enabled: origin !== null, retry: false },
  );

  const startConnection = () => {
    if (!availability.data?.available) return;
    const query = new URLSearchParams({ locale });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- OAuth start route（302 + cookie を返す redirect flow）であり SPA route ではない
    window.location.assign(`/api/integrations/google-calendar/start?${query.toString()}`);
  };

  const connectionRows = (connections.data ?? []) as ConnectionSummary[];
  return (
    <GoogleCalendarSettingsView
      loading={connections.isLoading}
      error={connections.isError}
      availabilityLoading={origin === null || availability.isLoading}
      available={availability.data?.available === true}
      hasConnections={connectionRows.length > 0}
      onRetry={() => void connections.refetch()}
      onConnect={startConnection}
    >
      {connectionRows.map((connection) => (
        <GoogleCalendarConnection
          key={connection.id}
          connection={connection}
          origin={origin}
          reconnectAvailable={availability.data?.available === true}
        />
      ))}
    </GoogleCalendarSettingsView>
  );
}

function GoogleCalendarConnection({
  connection,
  origin,
  reconnectAvailable,
}: {
  connection: ConnectionSummary;
  origin: string | null;
  reconnectAvailable: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations('settings.integrations.googleCalendar');
  const utils = api.useUtils();
  // server は listProviderCalendars / updateSelectedCalendars / syncNow を利用権無しで
  // 拒否する（`lib/billing/operation-access.ts`）。ここで止めないと汎用の失敗 toast だけが
  // 残る。切断・一覧・同期状態の閲覧は終了後も許されるので gate しない。
  const { canUseProduct } = useBillingAccess();
  const storedNeedsReauth = connection.status === 'reauth_required';
  const [draftSelection, setDraftSelection] = useState<{
    connectionId: string;
    serverSelectionKey: string;
    ids: string[];
  } | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const syncStatus = api.externalCalendar.getSyncStatus.useQuery(
    { connectionId: connection.id },
    { retry: false },
  );
  const providerCalendars = api.externalCalendar.listProviderCalendars.useQuery(
    { connectionId: connection.id },
    { enabled: !storedNeedsReauth && canUseProduct, retry: false },
  );

  // calendarList の取得中に token 失効を検知すると service が行を reauth_required に更新して
  // CONFLICT を返す。listConnections の次回 refetch を待たず、その場で再接続導線へ収束させる。
  const needsReauth = storedNeedsReauth || providerCalendars.error?.data?.code === 'CONFLICT';

  const calendars = useMemo(
    () => (providerCalendars.data ?? []) as GoogleCalendarOption[],
    [providerCalendars.data],
  );
  const serverSelectedIds = useMemo(
    () => calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id),
    [calendars],
  );
  const serverSelectionKey = [...serverSelectedIds].sort().join('\u0000');

  const draftIsCurrent =
    draftSelection?.connectionId === connection.id &&
    draftSelection.serverSelectionKey === serverSelectionKey;
  const selectedIds = draftIsCurrent ? draftSelection.ids : serverSelectedIds;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectionDirty = !sameStringSet(selectedIds, serverSelectedIds);

  const updateSelection = api.externalCalendar.updateSelectedCalendars.useMutation({
    retry: false,
    onMutate: async (input) => {
      const queryInput = { connectionId: connection.id };
      await Promise.all([
        utils.externalCalendar.listProviderCalendars.cancel(queryInput),
        utils.externalCalendar.getSyncStatus.cancel(queryInput),
      ]);
      const previousProvider = utils.externalCalendar.listProviderCalendars.getData(queryInput);
      const previousStatus = utils.externalCalendar.getSyncStatus.getData(queryInput);
      const nextIds = new Set(input.calendars.map((calendar) => calendar.providerCalendarId));

      utils.externalCalendar.listProviderCalendars.setData(queryInput, (current) =>
        current?.map((calendar) => ({ ...calendar, selected: nextIds.has(calendar.id) })),
      );
      utils.externalCalendar.getSyncStatus.setData(queryInput, (current) =>
        current
          ? {
              ...current,
              calendars: input.calendars.map((calendar) => ({
                provider_calendar_id: calendar.providerCalendarId,
                calendar_name: calendar.calendarName ?? null,
                last_synced_at:
                  current.calendars.find(
                    (row) => row.provider_calendar_id === calendar.providerCalendarId,
                  )?.last_synced_at ?? null,
              })),
            }
          : current,
      );
      return { previousProvider, previousStatus };
    },
    onSuccess: (result) => showSyncOutcomeToast(t, result.outcome),
    onError: (_error, _input, context) => {
      const queryInput = { connectionId: connection.id };
      // UI cache の暫定復元のみ。DB の選択保存と同期は transaction ではないため、
      // settled の refetch で必ず server の実結果へ収束させる。
      utils.externalCalendar.listProviderCalendars.setData(queryInput, context?.previousProvider);
      utils.externalCalendar.getSyncStatus.setData(queryInput, context?.previousStatus);
      toast.error(t('outcomes.updateFailed'));
    },
    onSettled: async () => {
      setDraftSelection(null);
      const queryInput = { connectionId: connection.id };
      await Promise.all([
        utils.externalCalendar.listConnections.invalidate(),
        utils.externalCalendar.listProviderCalendars.invalidate(queryInput),
        utils.externalCalendar.getSyncStatus.invalidate(queryInput),
        // 選択解除・再選択でミラー内容が変わる。calendar 画面がどの範囲を開いているか
        // ここからは分からないので範囲を限定せず invalidate する。
        utils.externalCalendar.listEvents.invalidate(),
      ]);
    },
  });

  const syncNow = api.externalCalendar.syncNow.useMutation({
    retry: false,
    onSuccess: (result) => showSyncOutcomeToast(t, result.outcome),
    onError: () => toast.error(t('outcomes.syncFailed')),
    onSettled: async () => {
      const queryInput = { connectionId: connection.id };
      await Promise.all([
        utils.externalCalendar.listConnections.invalidate(),
        utils.externalCalendar.getSyncStatus.invalidate(queryInput),
        // 手動同期でミラーが更新される。同上、範囲を限定せず invalidate する。
        utils.externalCalendar.listEvents.invalidate(),
      ]);
    },
  });

  const disconnect = api.externalCalendar.disconnect.useMutation({
    retry: false,
    onMutate: async () => {
      // 破壊操作は楽観的に消さない。進行中の一覧 fetch だけ止め、settled 後に server を正とする。
      await utils.externalCalendar.listConnections.cancel();
    },
    onSuccess: () => {
      setDisconnectOpen(false);
      toast.success(t('disconnectSuccess'));
    },
    onError: () => toast.error(t('disconnectFailed')),
    onSettled: async () => {
      const queryInput = { connectionId: connection.id };
      await Promise.all([
        utils.externalCalendar.listConnections.invalidate(),
        utils.externalCalendar.listProviderCalendars.invalidate(queryInput),
        utils.externalCalendar.getSyncStatus.invalidate(queryInput),
        // 切断で未参照ミラーが即掃除される。同上、範囲を限定せず invalidate する。
        utils.externalCalendar.listEvents.invalidate(),
      ]);
    },
  });

  const currentConnection = syncStatus.data?.connection ?? connection;
  const currentStatus = needsReauth ? 'reauth_required' : currentConnection.status;
  const reconnect = () => {
    if (!origin) return;
    const query = new URLSearchParams({ locale, reconnectConnectionId: connection.id });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- OAuth start route（302 + cookie を返す redirect flow）であり SPA route ではない
    window.location.assign(`/api/integrations/google-calendar/start?${query.toString()}`);
  };

  const apply = () => {
    if (!canUseProduct) return;
    updateSelection.mutate({
      connectionId: connection.id,
      calendars: calendars
        .filter((calendar) => selectedSet.has(calendar.id))
        .map((calendar) => ({ providerCalendarId: calendar.id, calendarName: calendar.name })),
    });
  };

  return (
    <>
      <GoogleCalendarConnectionView
        email={currentConnection.provider_account_email}
        lastSyncedLabel={formatLastSync(currentConnection.last_synced_at, locale, t('neverSynced'))}
        statusLabel={statusLabel(t, currentStatus)}
        statusVariant={currentStatus === 'active' ? 'success' : 'warning'}
        persistedError={persistedErrorMessage(t, currentConnection.last_sync_error)}
        needsReauth={needsReauth}
        readOnly={!canUseProduct}
        reconnectAvailable={reconnectAvailable}
        calendars={calendars}
        selectedCalendarIds={selectedSet}
        calendarsLoading={providerCalendars.isLoading}
        calendarsError={providerCalendars.isError || syncStatus.isError}
        applying={updateSelection.isPending}
        syncing={syncNow.isPending}
        disconnecting={disconnect.isPending}
        selectionDirty={selectionDirty}
        onToggleCalendar={(calendarId, checked) => {
          const next = new Set(selectedIds);
          if (checked) next.add(calendarId);
          else next.delete(calendarId);
          setDraftSelection({
            connectionId: connection.id,
            serverSelectionKey,
            ids: [...next],
          });
        }}
        onRetryCalendars={() => {
          void Promise.all([providerCalendars.refetch(), syncStatus.refetch()]);
        }}
        onApply={apply}
        onSync={() => {
          if (!canUseProduct) return;
          syncNow.mutate({ connectionId: connection.id });
        }}
        onReconnect={reconnect}
        onDisconnect={() => setDisconnectOpen(true)}
      />

      <ConfirmDialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={async () => {
          await disconnect.mutateAsync({ connectionId: connection.id }).catch(() => undefined);
        }}
        title={t('disconnectDialog.title')}
        description={t('disconnectDialog.description')}
        confirmLabel={t('disconnect')}
        loadingLabel={t('disconnecting')}
        variant="destructive"
      />
    </>
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function formatLastSync(value: string | null, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusLabel(
  t: ReturnType<typeof useTranslations<'settings.integrations.googleCalendar'>>,
  status: string,
): string {
  if (status === 'active') return t('status.connected');
  if (status === 'reauth_required') return t('status.reauthRequired');
  return t('status.issue');
}

function persistedErrorMessage(
  t: ReturnType<typeof useTranslations<'settings.integrations.googleCalendar'>>,
  error: string | null,
): string | null {
  if (!error) return null;
  switch (error) {
    case 'reauth_required':
      return t('errors.reauthRequired');
    case 'rate_limited':
      return t('errors.rateLimited');
    case 'provider_unavailable':
      return t('errors.providerUnavailable');
    case 'encryption_key_invalid':
      return t('errors.encryptionKeyInvalid');
    case 'partial_failure':
      return t('errors.partialFailure');
    case 'partial_timeout':
      return t('errors.partialTimeout');
    default:
      return t('errors.generic');
  }
}

function showSyncOutcomeToast(
  t: ReturnType<typeof useTranslations<'settings.integrations.googleCalendar'>>,
  outcome: SyncOutcome,
): void {
  switch (outcome) {
    case 'synced':
      toast.success(t('outcomes.synced'));
      break;
    case 'skipped_reauth_required':
    case 'reauth_required':
      toast.error(t('outcomes.reauthRequired'));
      break;
    case 'encryption_key_invalid':
      toast.error(t('outcomes.encryptionKeyInvalid'));
      break;
    case 'partial_failure':
      toast.error(t('outcomes.partialFailure'));
      break;
    case 'partial_timeout':
      toast.error(t('outcomes.partialTimeout'));
      break;
    case 'not_configured':
      toast.error(t('outcomes.notConfigured'));
      break;
  }
}
