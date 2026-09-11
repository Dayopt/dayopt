import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const translate = (key: string, values?: Record<string, unknown>) => {
      const base = namespace ? `${namespace}.${key}` : key;
      return values ? `${base} ${Object.values(values).join(' ')}` : base;
    };
    translate.raw = (key: string) =>
      key === 'labels'
        ? ['朝', '午前', '昼', '午後', '夜', '深夜']
        : ['日', '月', '火', '水', '木', '金', '土'];
    return translate;
  },
}));

import { setDomSlot } from '@/lib/dom-slots/useDomSlot';

import {
  REPORT_DETAIL_PANEL_DEFAULT_WIDTH,
  REPORT_DETAIL_PANEL_MAX_WIDTH,
  REPORT_DETAIL_PANEL_MIN_WIDTH,
  REPORT_DETAIL_SLOT_KEY,
} from '../../lib/report-detail-slot';
import { useReportDetailStore } from '../../stores/useReportDetailStore';
import { ReportDetailPanel } from './ReportDetailPanel';

import type { ReportActivityDetailResult } from '../../server/report-detail-service';

function detail(overrides: Partial<ReportActivityDetailResult> = {}): ReportActivityDetailResult {
  return {
    recordedMinutes: 600,
    plannedMinutes: 480,
    plannedPastMinutes: 480,
    plannedPastBoxes: 4,
    medianBoxMinutes: 90,
    medianPlanBoxMinutes: 80,
    fulfillment: { low: 1, medium: 0, high: 3 },
    timeOfDay: [60, 240, 120, 180, 0, 0],
    trend: [
      { key: '2026-08-03', recordedMinutes: 0, medianBoxMinutes: null },
      { key: '2026-08-10', recordedMinutes: 300, medianBoxMinutes: 150 },
      { key: '2026-08-17', recordedMinutes: 420, medianBoxMinutes: 140 },
      { key: '2026-08-24', recordedMinutes: 0, medianBoxMinutes: null },
      { key: '2026-08-31', recordedMinutes: 600, medianBoxMinutes: 90 },
      { key: '2026-09-07', recordedMinutes: 0, medianBoxMinutes: null },
    ],
    records: [
      record('rec-1', 90, { startAt: '2026-09-01T01:00:00.000Z', fulfillment: 'high' }),
      // 曜日と時刻が重ならないよう別の日に置く（明細の行を text で引く test があるため）
      record('rec-2', 60, { startAt: '2026-09-02T01:00:00.000Z' }),
      record('rec-3', 120, { startAt: '2026-09-03T01:00:00.000Z' }),
    ],
    ...overrides,
  };
}

/** 明細 1 件。長さだけ変えたい test が多いので分単位を第 2 引数に取る。 */
function record(
  id: string,
  minutes: number,
  overrides: Partial<ReportActivityDetailResult['records'][number]> = {},
): ReportActivityDetailResult['records'][number] {
  const startAt = overrides.startAt ?? '2026-09-01T01:00:00.000Z';
  return {
    id,
    title: '執筆',
    startAt,
    endAt: new Date(Date.parse(startAt) + minutes * 60_000).toISOString(),
    minutes,
    fulfillment: null,
    note: null,
    source: 'manual',
    ...overrides,
  };
}

function renderPanel(overrides: Partial<Parameters<typeof ReportDetailPanel>[0]> = {}) {
  return render(
    <ReportDetailPanel
      categoryName="仕事"
      color="blue"
      detail={detail()}
      granularity="week"
      timezone="Asia/Tokyo"
      isError={false}
      isPending={false}
      name="執筆"
      onClose={() => {}}
      onOpenCalendarDay={() => {}}
      {...overrides}
    />,
  );
}

describe('ReportDetailPanel', () => {
  beforeEach(() => {
    // shell が用意する slot を test でも作る（未登録なら何も描かない仕様）
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    setDomSlot(REPORT_DETAIL_SLOT_KEY, slot);
    // jsdom は scrollIntoView を持たない（ストリップの点が明細へ着地する経路で呼ぶ）
    Element.prototype.scrollIntoView = vi.fn();
    useReportDetailStore.setState({ width: REPORT_DETAIL_PANEL_DEFAULT_WIDTH, isResizing: false });
  });

  it('slot が未登録なら何も描かない', () => {
    setDomSlot(REPORT_DETAIL_SLOT_KEY, null);
    renderPanel();

    expect(document.querySelector('[data-report-panel="detail"]')).toBeNull();
  });

  it('予定比・中央値・充実の分布を出す', () => {
    renderPanel();

    // 600 / 480 = 125%
    expect(screen.getByText('report.detail.stats.planRatio 125')).toBeInTheDocument();
    // 中央値は統計カードの中を見る（同じ `1:30` が明細の 1 行にも出る）
    const stats = document.querySelector('[data-report-stats="detail"]') as HTMLElement;
    expect(within(stats).getByText('1:30')).toBeInTheDocument();
    expect(
      screen.getByText(
        'report.detail.stats.fulfillmentLevel.high 3 report.detail.stats.fulfillmentLevel.low 1',
      ),
    ).toBeInTheDocument();
  });

  it('過去予定が閾値未満なら率を作らず状態を出す', () => {
    renderPanel({ detail: detail({ plannedPastMinutes: 0, plannedMinutes: 240 }) });

    expect(screen.getByText('report.detail.stats.planPending')).toBeInTheDocument();
    expect(screen.queryByText(/planRatio/)).not.toBeInTheDocument();
  });

  it('予定が無ければ「予定なし」を出す', () => {
    renderPanel({ detail: detail({ plannedMinutes: 0, plannedPastMinutes: 0 }) });

    expect(screen.getByText('report.detail.stats.planNone')).toBeInTheDocument();
  });

  it('中央値 0 件はダッシュ、充実 0 件は未回答', () => {
    renderPanel({
      detail: detail({ medianBoxMinutes: null, fulfillment: { low: 0, medium: 0, high: 0 } }),
    });

    expect(screen.getByText('report.detail.stats.none')).toBeInTheDocument();
    expect(screen.getByText('report.detail.stats.unanswered')).toBeInTheDocument();
  });

  /** 仕様 §6-5。データのある期間が 2 未満なら節ごと消える。 */
  it('推移はデータのある期間が 2 未満なら節ごと出さない', () => {
    const { rerender } = renderPanel();
    expect(document.querySelector('[data-report-bars="trend"]')).not.toBeNull();

    rerender(
      <ReportDetailPanel
        categoryName="仕事"
        color="blue"
        detail={detail({
          trend: [
            { key: 'a', recordedMinutes: 0, medianBoxMinutes: null },
            { key: 'b', recordedMinutes: 0, medianBoxMinutes: null },
            { key: 'c', recordedMinutes: 120, medianBoxMinutes: 120 },
          ],
        })}
        granularity="week"
        timezone="Asia/Tokyo"
        isError={false}
        isPending={false}
        name="執筆"
        onClose={() => {}}
        onOpenCalendarDay={() => {}}
      />,
    );

    expect(document.querySelector('[data-report-bars="trend"]')).toBeNull();
  });

  /**
   * ブラウザのローカル時刻で描くと、timezone 設定がずれている端末で明細とカレンダーが
   * 食い違う。`2026-09-01T01:00:00Z` は JST では 10:00。
   */
  it('明細の時刻と曜日をユーザーの timezone で描く', () => {
    renderPanel();

    expect(screen.getByText('10:00–11:30')).toBeInTheDocument();
    // 2026-09-01 は火曜
    expect(screen.getByText('火')).toBeInTheDocument();
  });

  it('「カレンダーで見る」は timezone で切った日を渡す', async () => {
    const onOpenCalendarDay = vi.fn();
    renderPanel({
      detail: detail({
        records: [
          // JST では 09-02 の 08:00。UTC の日付（09-01）で開くと 1 日ずれる
          record('rec-night', 30, { startAt: '2026-09-01T23:00:00.000Z' }),
        ],
      }),
      onOpenCalendarDay,
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(screen.getByText('report.detail.openCalendar'));

    expect(onOpenCalendarDay).toHaveBeenCalledWith('2026-09-02');
  });

  it('時間帯は 6 本すべて描く（0 のバケットも残す）', () => {
    renderPanel();

    expect(document.querySelectorAll('[data-report-bars="time-of-day"] > li')).toHaveLength(6);
  });

  it('明細が 0 件でも落ちず、空文言を出す', () => {
    renderPanel({ detail: detail({ records: [] }) });

    expect(screen.getByText('report.detail.records.empty')).toBeInTheDocument();
  });

  it('ストリップは記録が 3 件未満なら件数不足と出す', () => {
    renderPanel({ detail: detail({ records: [record('rec-1', 60), record('rec-2', 90)] }) });

    expect(screen.getByText('report.detail.strip.notEnough')).toBeInTheDocument();
    expect(document.querySelector('[data-report-strip="duration"]')).toBeNull();
  });

  it('ストリップは件数・中央値・25–75% と両端の長さを出す', () => {
    renderPanel();

    expect(screen.getByText('report.detail.strip.heading')).toBeInTheDocument();
    expect(screen.getByText('report.detail.strip.count 3')).toBeInTheDocument();
    // 60 / 90 / 120 の中央値
    expect(screen.getByText('report.detail.strip.median 1:30')).toBeInTheDocument();
    expect(screen.getByText('report.detail.strip.iqr 1:00 2:00')).toBeInTheDocument();

    // 軸は記録の 1:00〜2:00（予定の中央値 80 分は内側なので広がらない）。
    // 同じ `1:00` が明細の行にも出るのでストリップの節の中だけを見る
    const section = screen.getByText('report.detail.strip.heading').closest('div') as HTMLElement;
    const axisLabels = within(section)
      .getAllByText(/^\d+:\d{2}$/)
      .map((node) => node.textContent);
    expect(axisLabels).toEqual(['1:00', '2:00']);

    const strip = document.querySelector('[data-report-strip="duration"]') as HTMLElement;
    expect(within(strip).getAllByRole('button')).toHaveLength(3);
  });

  it('ストリップの点を押すと明細の該当行へ着地する', async () => {
    renderPanel();

    const strip = document.querySelector('[data-report-strip="duration"]') as HTMLElement;
    const { default: userEvent } = await import('@testing-library/user-event');
    // 点は長さ順ではなく明細の並び順。1 つ目は rec-1（90 分）
    await userEvent.setup().click(within(strip).getAllByRole('button')[0] as HTMLElement);

    const row = document.querySelector('[data-record-id="rec-1"]');
    expect(row).not.toBeNull();
    expect(row).toHaveFocus();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  /** 自動移行は「ユーザーが確定した実績」ではないので代表値に数えない（明細には残す）。 */
  it('auto_migrated の記録は明細に残るが点にはしない', () => {
    renderPanel({
      detail: detail({
        records: [
          record('rec-1', 60),
          record('rec-2', 90, { startAt: '2026-09-02T01:00:00.000Z' }),
          record('rec-3', 120, { startAt: '2026-09-03T01:00:00.000Z' }),
          record('rec-migrated', 480, {
            startAt: '2026-09-04T01:00:00.000Z',
            source: 'auto_migrated',
          }),
        ],
      }),
    });

    const strip = document.querySelector('[data-report-strip="duration"]') as HTMLElement;
    expect(within(strip).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('report.detail.strip.count 3')).toBeInTheDocument();
    expect(document.querySelector('[data-record-id="rec-migrated"]')).not.toBeNull();
  });

  it('予定の中央値が無ければ印を出さない', () => {
    const { rerender } = renderPanel();
    expect(screen.getByText('▲')).toBeInTheDocument();

    rerender(
      <ReportDetailPanel
        categoryName="仕事"
        color="blue"
        detail={detail({ medianPlanBoxMinutes: null })}
        granularity="week"
        timezone="Asia/Tokyo"
        isError={false}
        isPending={false}
        name="執筆"
        onClose={() => {}}
        onOpenCalendarDay={() => {}}
      />,
    );

    expect(screen.queryByText('▲')).toBeNull();
  });

  it('推移は中央値のある期間だけを線で結び、棒は 6 本のまま', () => {
    renderPanel();

    expect(document.querySelectorAll('[data-report-bars="trend"] > li')).toHaveLength(6);
    const line = document.querySelector('[data-report-line="trend-median"]') as SVGElement;
    // 中央値があるのは index 1・2（連続）と 4（孤立）。線は連続する 1 区間だけ
    expect(line.querySelectorAll('polyline')).toHaveLength(1);
    // 点は SVG の外（引き伸ばしで楕円に潰れるため）
    expect(document.querySelectorAll('[data-report-point="trend-median"]')).toHaveLength(3);
  });

  it('幅の区切りは矢印キーで動き、上限・下限に収まる', async () => {
    renderPanel();

    const separator = screen.getByRole('separator');
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    separator.focus();
    await user.keyboard('{ArrowLeft}');
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_DEFAULT_WIDTH + 16);

    await user.keyboard('{Home}');
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_MIN_WIDTH);

    // 下限で更に狭めても下限のまま
    await user.keyboard('{ArrowRight}');
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_MIN_WIDTH);

    await user.keyboard('{End}');
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_MAX_WIDTH);
  });

  it('ドラッグ中だけ isResizing になり、離すと幅が残る', () => {
    renderPanel();

    const separator = screen.getByRole('separator');
    fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
    expect(useReportDetailStore.getState().isResizing).toBe(true);

    // 左へ 60px 引く = パネルは 60px 広がる
    fireEvent.pointerMove(window, { clientX: 440 });
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_DEFAULT_WIDTH + 60);

    fireEvent.pointerUp(window);
    expect(useReportDetailStore.getState().isResizing).toBe(false);
    expect(useReportDetailStore.getState().width).toBe(REPORT_DETAIL_PANEL_DEFAULT_WIDTH + 60);
  });

  /** 仕様 §6。パネル内で編集はしない。 */
  it('編集用の入力を持たない', () => {
    renderPanel();

    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });

  it('読み込み中と失敗時は明細を描かない', () => {
    const { rerender } = renderPanel({ detail: undefined, isPending: true });
    expect(document.querySelector('[data-report-list="records"]')).toBeNull();

    rerender(
      <ReportDetailPanel
        categoryName="仕事"
        color="blue"
        detail={undefined}
        granularity="week"
        timezone="Asia/Tokyo"
        isError
        isPending={false}
        name="執筆"
        onClose={() => {}}
        onOpenCalendarDay={() => {}}
      />,
    );

    expect(screen.getByText('report.detail.error')).toBeInTheDocument();
  });
});
