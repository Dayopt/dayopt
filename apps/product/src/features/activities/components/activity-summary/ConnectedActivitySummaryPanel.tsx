'use client';

import { useEffect } from 'react';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { useActivityDetailStore } from '@/lib/stores/useActivityDetailStore';
import { useActivitiesMap } from '../../hooks/useActivitiesMap';

import { useActivitySummary } from '../../hooks/useActivitySummary';
import { ActivitySummaryDesktopPanel, ActivitySummaryPanel } from './ActivitySummaryPanel';
import { ActivitySummarySheet } from './ActivitySummarySheet';

interface ActivitySummaryPanelProps {
  surface: 'panel' | 'sheet';
  onOpenRecord?: ((target: { id: string; dayKey: string }) => void) | undefined;
}

export function ConnectedActivitySummaryPanel({
  surface,
  onOpenRecord,
}: ActivitySummaryPanelProps) {
  const isOpen = useActivityDetailStore((state) => state.isOpen);
  const target = useActivityDetailStore((state) => state.target);

  useEffect(() => () => useActivityDetailStore.getState().close(), []);

  if (!isOpen || target === null) return null;
  return (
    <OpenActivitySummaryPanel
      key={target.activityId}
      target={target}
      surface={surface}
      onOpenRecord={onOpenRecord}
    />
  );
}

function OpenActivitySummaryPanel({
  target,
  surface,
  onOpenRecord,
}: ActivitySummaryPanelProps & {
  target: import('@/lib/stores/useActivityDetailStore').ActivityDetailTarget;
}) {
  const close = useActivityDetailStore((state) => state.close);
  const timezone = useUserPreferences((state) => state.timezone);
  const { getActivityById, isLoading: isLoadingActivities } = useActivitiesMap();
  const activity = getActivityById(target.activityId);
  const { data, isPending, isError, refetch } = useActivitySummary(target.activityId, true);
  useEffect(() => {
    if (!isLoadingActivities && !activity) close();
  }, [activity, close, isLoadingActivities]);
  const displayTarget = activity
    ? {
        ...target,
        name: activity.name,
        categoryName: activity.categoryName,
        color: activity.color,
      }
    : target;
  const content = (
    <ActivitySummaryPanel
      target={displayTarget}
      data={data}
      timezone={timezone}
      isPending={isPending}
      isError={isError}
      onRetry={() => void refetch()}
      onClose={close}
      onOpenRecord={onOpenRecord}
    />
  );

  return surface === 'sheet' ? (
    <ActivitySummarySheet open content={content} onClose={close} />
  ) : (
    <ActivitySummaryDesktopPanel content={content} />
  );
}
