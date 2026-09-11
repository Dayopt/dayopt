'use client';

import { useEffect } from 'react';

import { useUserPreferences } from '@/lib/hooks/useUserPreferences';

import { useReportActivityDetail } from '../../hooks/useReportActivityDetail';
import { useReportDetailStore } from '../../stores/useReportDetailStore';
import { ReportDetailPanel } from './ReportDetailPanel';
import { ReportDetailSheet } from './ReportDetailSheet';

import type { ReportGranularity } from '../../lib/report-period';
import type { ReportDetailTarget } from '../../stores/useReportDetailStore';

interface ConnectedReportDetailPanelProps {
  anchorDate: string;
  granularity: ReportGranularity;
  /**
   * 器の選択。`sheet` はモバイルのボトムシート（推移なし）、`panel` はデスクトップの
   * 4 カラム目。**Composition Bridge が決める** — review 本体は器を知らない。
   */
  surface: 'panel' | 'sheet';
}

/**
 * 詳細パネルの配線（store + query）。
 *
 * **`ReportBody` からではなく Composition Bridge から描く。** この component は tRPC query を
 * 持つので、`ReportBody` の中に置くと `/report` 以外（単体 test・Storybook）から描いた時に
 * context を要求してしまう（#2580 で踏んだ落とし穴）。章 → パネルの受け渡しは
 * `useReportDetailStore` が担うので、`ReportBody` は store の action を呼ぶだけで済む。
 *
 * 器は `surface` で決まる（デスクトップ = 4 カラム目のパネル / モバイル = ボトムシート）。
 * 見た目は `ReportDetailBody` に閉じており、Story はそちらに書く。
 */
export function ConnectedReportDetailPanel({
  anchorDate,
  granularity,
  surface,
}: ConnectedReportDetailPanelProps) {
  const isOpen = useReportDetailStore((state) => state.isOpen);
  const target = useReportDetailStore((state) => state.target);

  // `/report` を離れたら閉じる。**store は shell の 4 カラム目の開閉も握っている**ので、
  // 開いたままカレンダーへ移ると、中身の無い帯がカレンダー側に残る
  // （パネル本体はこの component と一緒に unmount されるが、幅は shell が持つため）。
  useEffect(() => () => useReportDetailStore.getState().close(), []);

  // **閉じている間は query を持つ component ごとマウントしない。** `enabled: false` で
  // 済ませると hook は呼ばれるので、`/report` を描くだけで tRPC context が要る形になる
  // （`ReportViewClient` の単体 test がそれで落ちた）。開いた時だけ配線する。
  if (!isOpen || target === null) return null;

  return (
    <OpenReportDetailPanel
      anchorDate={anchorDate}
      granularity={granularity}
      surface={surface}
      target={target}
    />
  );
}

function OpenReportDetailPanel({
  anchorDate,
  granularity,
  surface,
  target,
}: ConnectedReportDetailPanelProps & { target: ReportDetailTarget }) {
  const close = useReportDetailStore((state) => state.close);
  // 明細の時刻と曜日は、ブラウザのローカルではなくユーザー設定の timezone で切る
  const timezone = useUserPreferences((state) => state.timezone);
  // シートは推移を出さないので、**取得もしない**（表示側だけで落とすと運ぶだけ無駄になる）
  const { data, isPending, isError } = useReportActivityDetail({
    activityId: target.activityId,
    anchorDate,
    granularity,
    enabled: true,
    includeTrend: surface === 'panel',
  });

  const body = {
    categoryName: target.categoryName,
    color: target.color,
    detail: data,
    granularity,
    isError,
    isPending,
    name: target.name,
    onClose: close,
    timezone,
  };

  return surface === 'sheet' ? (
    <ReportDetailSheet {...body} open />
  ) : (
    <ReportDetailPanel {...body} />
  );
}
