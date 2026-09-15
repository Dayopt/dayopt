import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `t(key)` は namespace 付きのキーをそのまま返し、値を持つものは末尾へ並べる。
 * 文言そのものではなく「どの値がどこへ出たか」を見たいので、翻訳は素通しにする。
 */
vi.mock('next-intl', () => ({
  useLocale: () => 'ja',
  useTranslations: (namespace?: string) => {
    const translate = (key: string, values?: Record<string, unknown>) => {
      const base = namespace ? `${namespace}.${key}` : key;
      return values ? `${base} ${Object.values(values).join(' ')}` : base;
    };
    translate.raw = () => ['月', '火', '水', '木', '金', '土', '日'];
    return translate;
  },
}));

vi.mock('../../hooks/useReviewOpenedTracking', () => ({
  useReviewOpenedTracking: () => {},
}));

/** anchor ごとに別の集計を返す。引数を無視すると「期間を移動した」test が嘘になる。 */
const useReportPeriod = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useReportPeriod', () => ({ useReportPeriod }));

import { useReportDetailStore } from '../../stores/useReportDetailStore';
import { useReportViewStore } from '../../stores/useReportViewStore';
import { ReportBody } from './ReportBody';

import type { ReportTab } from '../../lib/report-tab';

import { REPORT_ALLOCATION, REPORT_EXECUTION } from '@/lib/test/e2e/report-selectors';

/**
 * 週 = 10080 分。記録は 仕事 600 + 睡眠 2400 + 未分類 60 = 3060 分。
 * したがって余白は 10080 − 3060 = 7020 分（= 117:00）で、**フィルタでは動かない**。
 */
const PERIOD_DATA = {
  period: { startAt: '', endAt: '', lengthMinutes: 10080, bucketKeys: ['2026-08-31'] },
  previous: { startAt: '', endAt: '', lengthMinutes: 10080 },
  nowAt: '2026-09-04T00:00:00.000Z',
  activities: [
    aggregate({
      activityId: 'act-dev',
      activityName: '実装',
      categoryId: 'cat-work',
      categoryName: '仕事',
      categoryColor: 'blue',
      recordedMinutes: 600,
    }),
    aggregate({
      activityId: 'act-sleep',
      activityName: '就寝',
      categoryId: 'cat-sleep',
      categoryName: '睡眠',
      categoryColor: 'indigo',
      recordedMinutes: 2400,
    }),
    aggregate({
      activityId: 'act-walk',
      activityName: '散歩',
      categoryId: null,
      categoryName: null,
      categoryColor: null,
      recordedMinutes: 60,
    }),
  ],
  previousActivities: [],
};

/** 前週。睡眠を 1200 分に減らし、記録合計 = 1860 分にした集計。 */
const PREVIOUS_WEEK_DATA = {
  ...PERIOD_DATA,
  activities: PERIOD_DATA.activities.map((activity) =>
    activity.activityId === 'act-sleep'
      ? { ...activity, recordedMinutes: 1200, byBucket: [1200] }
      : activity,
  ),
};

function renderBody(tab: ReportTab = 'usage') {
  return render(<ReportBody anchorDate="2026-09-02" granularity="week" tab={tab} />);
}

/** 記録時間のカードの大きい数字（見えているインク `V`）。 */
function headline() {
  return document.querySelector('[data-report-summary="recorded"]')?.textContent;
}

/** 記録時間のカードに添えた「余白 x」。余白の値がフィルタで動かないことを見る。 */
function subtitle() {
  return screen.getByText(/^report\.allocation\.cards\.margin/).textContent;
}

/** 配分の横棒の一覧。無ければ null（アクティビティ 1 つだけの時は省く）。 */
function bars() {
  return document.querySelector('[data-report-bars="allocation"]');
}

/** 配分の横棒が塗っている割合の合計（%）。分母は記録の合計なので、常に 100 になる。 */
function paintedPercent() {
  return [...document.querySelectorAll('[data-report-bar]')].reduce(
    (total, span) => total + Number.parseFloat((span as HTMLElement).style.width),
    0,
  );
}

/** 一覧の行（詳細を開くボタン）を名前で引く。 */
function usageRow(name: string) {
  return screen.getByRole('button', { name: `report.allocation.table.rowAriaLabel ${name}` });
}

describe('ReportBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useReportPeriod.mockImplementation((anchorDate: string) => ({
      data: anchorDate === '2026-08-26' ? PREVIOUS_WEEK_DATA : PERIOD_DATA,
      isPending: false,
      isError: false,
    }));
    useReportDetailStore.getState().close();
    localStorage.clear();
    useReportViewStore.setState({
      hiddenCategoryIds: [],
      hiddenActivityIds: [],
    });
  });

  it('既定ではすべてのカテゴリーが分母に入り、配分は記録の合計を 100% にする', () => {
    renderBody();

    expect(headline()).toBe('51時間');
    expect(document.querySelector('[data-report-summary="count"]')).toHaveTextContent(
      'report.allocation.cards.countValue 3',
    );
    // 余白はカードの小さな注記にだけ出す（配分には混ぜない）
    expect(subtitle()).toBe('report.allocation.cards.margin 117時間');
    // 前期間に記録が無いので差を作らない
    expect(screen.getAllByText('report.allocation.cards.noPrevious')).toHaveLength(3);
    expect(screen.getByText('仕事')).toBeInTheDocument();
    expect(screen.getByText('睡眠')).toBeInTheDocument();

    expect(paintedPercent()).toBeCloseTo(100, 5);
    // 一覧は記録の多い順
    expect(
      [...document.querySelectorAll('[data-report-table="usage"] li button')].map((row) =>
        row.getAttribute('aria-label'),
      ),
    ).toEqual([
      'report.allocation.table.rowAriaLabel 就寝 40時間',
      'report.allocation.table.rowAriaLabel 実装 10時間',
      'report.allocation.table.rowAriaLabel 散歩 1時間',
    ]);
  });

  /**
   * 仕様 §13-2。カテゴリーを 1 つ隠すと `V` と `track` から抜けるが、**余白は動かない**。
   * `computeDenominators` の `allActivities` にフィルタを掛けると、ここが落ちる。
   */
  it('睡眠を隠すと V から睡眠分が抜け、余白の値は変わらない', () => {
    useReportViewStore.setState({ hiddenCategoryIds: ['cat-sleep'] });
    renderBody();

    expect(headline()).toBe('11時間');
    expect(subtitle()).toContain('117時間');
    expect(screen.queryByText('睡眠')).not.toBeInTheDocument();
    expect(screen.getByText('仕事')).toBeInTheDocument();
    // 分母も 11:00 に縮むので、残った区画で 100% になる
    expect(paintedPercent()).toBeCloseTo(100, 5);
  });

  /**
   * 前期間の数字は「今見えているアクティビティ」だけで足す。フィルタを掛けたまま期間を比べる。
   * 件数と中央値の差も同じ集合から出す。
   */
  it('カードの前期間比を、見えているアクティビティだけで出す', () => {
    useReportPeriod.mockImplementation(() => ({
      data: {
        ...PERIOD_DATA,
        previousActivities: [
          {
            activityId: 'act-dev',
            recordedMinutes: 300,
            recordBoxes: 2,
            durationCounts: [[150, 2]],
          },
          // 隠している睡眠の前期間は比べない
          {
            activityId: 'act-sleep',
            recordedMinutes: 2400,
            recordBoxes: 1,
            durationCounts: [[2400, 1]],
          },
        ],
      },
      isPending: false,
      isError: false,
    }));
    useReportViewStore.setState({ hiddenCategoryIds: ['cat-sleep'] });
    renderBody();

    // 記録時間: 11:00（実装 600 + 散歩 60）− 前期間 5:00（実装 300）= +6:00
    expect(document.querySelector('[data-report-summary-delta="recorded"]')).toHaveTextContent(
      'report.allocation.cards.deltaLabel.week+6時間',
    );
    // 件数: 2 − 2 = 0
    expect(document.querySelector('[data-report-summary-delta="count"]')).toHaveTextContent(
      'report.allocation.cards.countDelta 0',
    );
  });

  it('時間帯と 1 件の長さの分布を、見えているアクティビティから描く', () => {
    useReportViewStore.setState({ hiddenCategoryIds: ['cat-sleep'] });
    renderBody();

    const hours = document.querySelector('[data-report-chart="hours"]');
    expect(hours?.children).toHaveLength(24);
    expect(hours?.children[0]?.firstElementChild).toHaveAttribute(
      'aria-label',
      'report.allocation.hours.barAriaLabel 0 11時間',
    );

    const durations = document.querySelector('[data-report-chart="durations"]');
    // 60 分（散歩）と 600 分（実装）の 2 件。睡眠（2400 分）は数えない
    const labels = [...(durations?.children ?? [])].map((bin) =>
      bin.firstElementChild?.getAttribute('aria-label'),
    );
    expect(labels).toContain(
      'report.allocation.durations.barAriaLabel report.allocation.durations.range 60 90 1',
    );
    expect(labels).toContain(
      'report.allocation.durations.barAriaLabel report.allocation.durations.rangeOpen 120 1',
    );
  });

  /** 仕様 §1 の表。見えているカテゴリーが 1 つになれば配下のアクティビティ別に割る。 */
  it('1 つのカテゴリーだけが残ると、配分はアクティビティ別に割れる', () => {
    // 仕事に 2 つ目のアクティビティを足す（1 つだけだと配分そのものを省く）
    useReportPeriod.mockImplementation(() => ({
      data: {
        ...PERIOD_DATA,
        activities: [
          ...PERIOD_DATA.activities,
          aggregate({
            activityId: 'act-mtg',
            activityName: '会議',
            categoryId: 'cat-work',
            categoryName: '仕事',
            categoryColor: 'blue',
            recordedMinutes: 300,
          }),
        ],
      },
      isPending: false,
      isError: false,
    }));
    useReportViewStore.setState({
      hiddenCategoryIds: ['cat-sleep'],
      hiddenActivityIds: ['act-walk'],
    });
    renderBody();

    expect(screen.getByText('report.allocation.breakdown.heading.activity')).toBeInTheDocument();
    expect(bars()).toHaveTextContent('実装');
    expect(bars()).toHaveTextContent('会議');
    expect(bars()).not.toHaveTextContent('仕事');
    expect(paintedPercent()).toBeCloseTo(100, 5);
  });

  it('アクティビティが 1 つだけなら配分を省き、一覧は残る', () => {
    useReportViewStore.setState({ hiddenActivityIds: ['act-sleep', 'act-walk'] });
    renderBody();

    expect(bars()).toBeNull();
    expect(usageRow('実装 10時間')).toBeInTheDocument();
  });

  it('一覧の行から詳細を開ける', async () => {
    const user = userEvent.setup();
    renderBody();

    await user.click(usageRow('実装 10時間'));

    expect(useReportDetailStore.getState().isOpen).toBe(true);
    expect(useReportDetailStore.getState().target?.activityId).toBe('act-dev');
  });

  it('一覧を前期間との差の順に並べ替えられる', async () => {
    const user = userEvent.setup();
    useReportPeriod.mockImplementation(() => ({
      data: {
        ...PERIOD_DATA,
        // 前週: 実装 100（+500）、就寝 2400（±0）、散歩 0（+60）
        previousActivities: [
          {
            activityId: 'act-dev',
            recordedMinutes: 100,
            recordBoxes: 1,
            durationCounts: [[100, 1]],
          },
          {
            activityId: 'act-sleep',
            recordedMinutes: 2400,
            recordBoxes: 1,
            durationCounts: [[2400, 1]],
          },
        ],
      },
      isPending: false,
      isError: false,
    }));
    renderBody();

    await user.click(screen.getByRole('button', { name: 'report.allocation.table.sort.delta' }));

    expect(
      [...document.querySelectorAll('[data-report-table="usage"] li button')].map((row) =>
        row.getAttribute('aria-label'),
      ),
    ).toEqual([
      'report.allocation.table.rowAriaLabel 実装 10時間',
      'report.allocation.table.rowAriaLabel 散歩 1時間',
      'report.allocation.table.rowAriaLabel 就寝 40時間',
    ]);
  });

  it('未分類のアクティビティを隠すとその分だけ抜け、凡例の未分類も消える', () => {
    useReportViewStore.setState({ hiddenActivityIds: ['act-walk'] });
    renderBody();

    expect(headline()).toBe('50時間');
    expect(screen.queryByText('report.allocation.uncategorized')).not.toBeInTheDocument();
  });

  /**
   * アクティビティ単位のフィルタ。カテゴリーの行は残り、そのカテゴリーの合計だけが減る。
   * 余白は `allActivities` から出すので、ここでも動かない（仕様 §10 の 13-2）。
   */
  it('アクティビティを隠すとそのぶんだけ V から抜け、余白の値は変わらない', () => {
    useReportViewStore.setState({ hiddenActivityIds: ['act-dev'] });
    renderBody();

    // 睡眠 2400 + 未分類 60 = 41:00
    expect(headline()).toBe('41時間');
    expect(subtitle()).toContain('117時間');
    expect(screen.queryByText('仕事')).not.toBeInTheDocument();
    expect(screen.getByText('睡眠')).toBeInTheDocument();
  });

  /**
   * 期間を移すと集計は入れ替わるが、フィルタは端末ローカルなので残る。
   * `useReportPeriod` のモックは anchor ごとに別データを返すので、
   * 「anchor を無視して同じ集計を出し続ける」退行はここで落ちる。
   */
  it('フィルタは期間の移動をまたいで保たれる', () => {
    useReportViewStore.setState({ hiddenCategoryIds: ['cat-sleep'] });
    const { rerender } = renderBody();
    expect(headline()).toBe('11時間');

    rerender(<ReportBody anchorDate="2026-08-26" granularity="week" tab="usage" />);

    expect(useReportPeriod).toHaveBeenLastCalledWith('2026-08-26', 'week');
    expect(useReportViewStore.getState().hiddenCategoryIds).toEqual(['cat-sleep']);

    // 前週も睡眠が抜けたまま（仕事 600 + 未分類 60 = 11:00）。余白だけが 10080 − 1860 へ動く
    expect(headline()).toBe('11時間');
    expect(subtitle()).toContain('137時間');
  });

  /**
   * 集計はブラウザに永続化される（`PersistQueryClientProvider`）。項目を足す前に保存された
   * 形（`durationCounts` / `byHour` / 前期間の `recordBoxes` が無い）が復元されても、面を落とさない。
   * dev の cache buster は固定値なので、コードを更新した直後の再読み込みで必ずこの形が来る。
   */
  it('項目が足りない古い形の集計が復元されても描ける', () => {
    const legacyActivities = PERIOD_DATA.activities.map(
      ({ durationCounts: _durationCounts, byHour: _byHour, ...rest }) => rest,
    );
    useReportPeriod.mockImplementation(() => ({
      data: {
        ...PERIOD_DATA,
        activities: legacyActivities,
        previousActivities: [{ activityId: 'act-dev', recordedMinutes: 300 }],
      },
      isPending: false,
      isError: false,
    }));

    renderBody();

    expect(headline()).toBe('51時間');
    expect(document.querySelector('[data-report-chart="hours"]')).toBeNull();
    expect(screen.getAllByText('report.allocation.hours.empty')).toHaveLength(1);
    expect(usageRow('実装 10時間')).toBeInTheDocument();
  });

  describe('タブ', () => {
    /** 各タブが自分の面だけを描く。操作前から存在する要素で通らないよう、他の面が無いことも見る。 */
    it.each<[ReportTab, string]>([
      ['usage', 'allocation'],
      ['diff', 'execution'],
      ['reflect', 'quality'],
    ])('%s タブは %s の面だけを描く', (tab, chapter) => {
      renderBody(tab);

      const chapters = [...document.querySelectorAll('[data-report-chapter]')].map((node) =>
        node.getAttribute('data-report-chapter'),
      );
      expect(chapters).toEqual([chapter]);
    });

    it('タブを切り替えても期間の query は同じ引数のまま（往復しない）', () => {
      const { rerender } = renderBody('usage');
      rerender(<ReportBody anchorDate="2026-09-02" granularity="week" tab="diff" />);

      expect(useReportPeriod.mock.calls.every((call) => call[0] === '2026-09-02')).toBe(true);
      expect(document.querySelector('[data-report-chapter="execution"]')).not.toBeNull();
    });

    /** 同じ期間・同じアクティビティの明細は、どの面から見ても同じ答えなので閉じない。 */
    it('タブを切り替えても詳細パネルは閉じない', async () => {
      const user = userEvent.setup();
      const { rerender } = renderBody('diff');
      await user.click(screen.getByRole('button', { name: /report.execution.rowAriaLabel 実装/ }));
      expect(useReportDetailStore.getState().isOpen).toBe(true);

      rerender(<ReportBody anchorDate="2026-09-02" granularity="week" tab="reflect" />);

      expect(useReportDetailStore.getState().isOpen).toBe(true);
    });

    it('期間を移すと詳細パネルは閉じる', async () => {
      const user = userEvent.setup();
      const { rerender } = renderBody('diff');
      await user.click(screen.getByRole('button', { name: /report.execution.rowAriaLabel 実装/ }));
      expect(useReportDetailStore.getState().isOpen).toBe(true);

      rerender(<ReportBody anchorDate="2026-08-26" granularity="week" tab="diff" />);

      expect(useReportDetailStore.getState().isOpen).toBe(false);
    });
  });

  /**
   * 詳細の器（デスクトップのパネル / モバイルのシート）は Composition Bridge が選ぶので、
   * **`ReportBody` はどの面でも開く口を渡す**。#2582 までは DOM slot の有無で塞いでいたが、
   * モバイルにシートができた今その判定は誤りになる（押せるのに開かない面が生まれる）。
   */
  it('章の行から詳細を開ける（器の有無を見ない）', async () => {
    const user = userEvent.setup();
    renderBody('diff');

    const row = screen.getByRole('button', { name: /report.execution.rowAriaLabel 実装/ });
    await user.click(row);

    expect(useReportDetailStore.getState().isOpen).toBe(true);
    expect(useReportDetailStore.getState().target?.activityId).toBe('act-dev');
  });

  /**
   * E2E が見ている data 属性がこの面に実在することを、per-PR の Unit Tests で固定する。
   *
   * E2E（`critical-path` / `derived-plan-record-flow` / `mobile-critical-path`）は
   * merge 必須チェックに入っておらず **main マージ後の promote でしか走らない**。
   * PR #2773 が `data-report-headline` → `data-report-summary` などを改名した時、
   * E2E 側が追従しないまま merge され、promote が赤になって初めて分かった（#2774）。
   * ここが同じ改名を per-PR で止める。**赤くなったら E2E 側も直す**のが正しい直し方で、
   * `report-selectors.ts` の値だけ合わせても E2E は直らない。
   */
  describe('E2E セレクタ契約（#2774）', () => {
    it.each<[ReportTab, string]>([
      ['usage', REPORT_ALLOCATION.chapter],
      ['usage', REPORT_ALLOCATION.recordedHeadline],
      ['usage', REPORT_ALLOCATION.breakdownRows],
      ['diff', REPORT_EXECUTION.chapter],
      ['diff', REPORT_EXECUTION.rows],
    ])('%s タブで %s が解決する', (tab, selector) => {
      renderBody(tab);

      expect(document.querySelectorAll(selector).length).toBeGreaterThan(0);
    });
  });
});

function aggregate(overrides: {
  activityId: string;
  activityName: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  recordedMinutes: number;
}) {
  return {
    categoryIcon: null,
    archived: false,
    plannedMinutes: 0,
    plannedPastMinutes: 0,
    plannedPastBoxes: 0,
    recordBoxes: 1,
    // 1 件ぶんの長さ = 記録時間。0 時台に全部置く（時間帯の合計と記録時間を揃える）
    durationCounts: [[overrides.recordedMinutes, 1]] as [number, number][],
    byHour: Array.from({ length: 24 }, (_, hour) => (hour === 0 ? overrides.recordedMinutes : 0)),
    fulfillment: { low: 0, medium: 0, high: 0 },
    byBucket: [overrides.recordedMinutes],
    ...overrides,
  };
}
