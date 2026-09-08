import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  GoogleCalendarConnectionView,
  GoogleCalendarSettingsView,
  type GoogleCalendarConnectionViewProps,
} from './GoogleCalendarSettingsView';

const CONNECTION_PROPS: GoogleCalendarConnectionViewProps = {
  email: 'user@example.com',
  lastSyncedLabel: 'neverSynced',
  statusLabel: 'status.connected',
  statusVariant: 'success',
  persistedError: null,
  needsReauth: false,
  reconnectAvailable: true,
  calendars: [],
  selectedCalendarIds: new Set(),
  calendarsLoading: false,
  calendarsError: false,
  applying: false,
  syncing: false,
  disconnecting: false,
  selectionDirty: false,
  onToggleCalendar: vi.fn(),
  onRetryCalendars: vi.fn(),
  onApply: vi.fn(),
  onSync: vi.fn(),
  onReconnect: vi.fn(),
  onDisconnect: vi.fn(),
};

describe('GoogleCalendarSettingsView', () => {
  it('未接続でも接続 CTA を表示する', async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(
      <GoogleCalendarSettingsView
        loading={false}
        error={false}
        availabilityLoading={false}
        available
        hasConnections={false}
        onRetry={vi.fn()}
        onConnect={onConnect}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'connect' }));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it('複数接続があってもアカウント追加 CTA を常に表示する', () => {
    render(
      <GoogleCalendarSettingsView
        loading={false}
        error={false}
        availabilityLoading={false}
        available
        hasConnections
        onRetry={vi.fn()}
        onConnect={vi.fn()}
      >
        <GoogleCalendarConnectionView {...CONNECTION_PROPS} email="first@example.com" />
        <GoogleCalendarConnectionView {...CONNECTION_PROPS} email="second@example.com" />
      </GoogleCalendarSettingsView>,
    );

    expect(screen.getByRole('button', { name: 'addAccount' })).toBeEnabled();
    expect(screen.getByText('first@example.com')).toBeInTheDocument();
    expect(screen.getByText('second@example.com')).toBeInTheDocument();
  });

  it('利用できない環境では接続と再接続を無効にする', () => {
    render(
      <GoogleCalendarSettingsView
        loading={false}
        error={false}
        availabilityLoading={false}
        available={false}
        hasConnections
        onRetry={vi.fn()}
        onConnect={vi.fn()}
      >
        <GoogleCalendarConnectionView
          {...CONNECTION_PROPS}
          needsReauth
          reconnectAvailable={false}
          persistedError="errors.reauthRequired"
        />
      </GoogleCalendarSettingsView>,
    );

    expect(screen.getByRole('button', { name: 'addAccount' })).toBeDisabled();
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.queryByText('description')).not.toBeInTheDocument();
    expect(screen.queryByText('empty')).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: 'reconnect' })) {
      expect(button).toBeDisabled();
    }
  });

  it('選択の適用中は後発編集と競合する操作を無効にする', () => {
    render(
      <GoogleCalendarConnectionView
        {...CONNECTION_PROPS}
        calendars={[{ id: 'work', name: 'Work', primary: true, selected: true }]}
        selectedCalendarIds={new Set(['work'])}
        selectionDirty
        applying
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Work' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'syncNow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'disconnect' })).toBeDisabled();
  });

  it('手動同期中は選択の適用と切断を無効にする', () => {
    render(
      <GoogleCalendarConnectionView
        {...CONNECTION_PROPS}
        calendars={[{ id: 'work', name: 'Work', primary: true, selected: true }]}
        selectedCalendarIds={new Set()}
        selectionDirty
        syncing
      />,
    );

    expect(screen.getByRole('button', { name: 'apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'disconnect' })).toBeDisabled();
  });
});
