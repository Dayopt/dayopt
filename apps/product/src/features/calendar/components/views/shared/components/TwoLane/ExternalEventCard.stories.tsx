import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { calculateExternalEventLayout } from '../../../../../lib/external-event-layout';
import { DEFAULT_PLAN_LANE_WIDTH_PERCENT } from '../../../../../lib/two-lane-layout';

import { ExternalEventCard } from './ExternalEventCard';
import { PlanLaneCard } from './PlanLaneCard';

const HOUR_HEIGHT = 60;
const DAY_START = new Date(2026, 6, 15, 0, 0);

function at(hour: number, minute = 0, dayOffset = 0): Date {
  return new Date(2026, 6, 15 + dayOffset, hour, minute);
}

/** 1 日カラムの一部を切り出した舞台。ghost は grid 内で絶対配置されるため。 */
function DayColumn({
  children,
  fromHour = 9,
  hours = 4,
}: {
  children: React.ReactNode;
  fromHour?: number;
  hours?: number;
}) {
  return (
    <div
      className="border-border relative w-64 overflow-hidden rounded-lg border"
      style={{ height: hours * HOUR_HEIGHT }}
    >
      <div style={{ position: 'absolute', inset: 0, top: -fromHour * HOUR_HEIGHT }}>{children}</div>
    </div>
  );
}

interface GhostSpec {
  id: string;
  title: string | null;
  calendarName: string | null;
  startDate: Date;
  endDate: Date;
}

function ghost(overrides: Partial<GhostSpec> & { id: string }): GhostSpec {
  return {
    title: '週次ミーティング',
    calendarName: 'Work',
    startDate: at(10),
    endDate: at(11),
    ...overrides,
  };
}

function Ghosts({
  events,
  laneWidthPercent = DEFAULT_PLAN_LANE_WIDTH_PERCENT,
  compact = false,
}: {
  events: GhostSpec[];
  laneWidthPercent?: number;
  compact?: boolean;
}) {
  const positions = calculateExternalEventLayout(events, {
    day: DAY_START,
    hourHeight: HOUR_HEIGHT,
    laneWidthPercent,
  });

  return (
    <>
      {events.map((event) => {
        const position = positions[event.id];
        if (!position) return null;
        return (
          <ExternalEventCard key={event.id} event={event} position={position} compact={compact} />
        );
      })}
    </>
  );
}

/**
 * 外部カレンダーの ghost カード（#1962、変換・dismiss 対応は #1985 / #1984）。
 *
 * Dayopt の Plan / Record と違い DB の EXCLUDE 制約が無いので重なる。座標は
 * `calculateExternalEventLayout` が出すため、Story も同じ関数を通して現実の見え方を再現する。
 */
const meta = {
  title: 'Product/Features/Calendar/TwoLane/ExternalEventCard',
  component: ExternalEventCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    event: ghost({ id: 'single' }),
    position: {
      top: 8,
      height: 60,
      left: 0,
      width: 92,
      displayStartDate: at(10),
      displayEndDate: at(11),
    },
  },
} satisfies Meta<typeof ExternalEventCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  render: (args) => (
    <DayColumn>
      <ExternalEventCard
        {...args}
        position={{
          top: 10 * HOUR_HEIGHT,
          height: 60,
          left: 0,
          width: 38,
          displayStartDate: at(10),
          displayEndDate: at(11),
        }}
      />
    </DayColumn>
  ),
};

export const OverlappingTwo: Story = {
  render: () => (
    <DayColumn>
      <Ghosts
        events={[
          ghost({ id: 'a', title: '1on1', startDate: at(10), endDate: at(11, 30) }),
          ghost({ id: 'b', title: 'レビュー会', startDate: at(10, 30), endDate: at(12) }),
        ]}
      />
    </DayColumn>
  ),
};

export const OverlappingThree: Story = {
  render: () => (
    <DayColumn>
      <Ghosts
        events={[
          ghost({ id: 'a', title: '全体朝会', startDate: at(10), endDate: at(12) }),
          ghost({ id: 'b', title: '面談', startDate: at(10, 15), endDate: at(12) }),
          ghost({ id: 'c', title: '打ち合わせ', startDate: at(10, 30), endDate: at(12) }),
        ]}
      />
    </DayColumn>
  ),
};

export const LongEvent: Story = {
  render: () => (
    <DayColumn hours={6}>
      <Ghosts
        events={[
          ghost({ id: 'a', title: '終日ワークショップ', startDate: at(9), endDate: at(15) }),
        ]}
      />
    </DayColumn>
  ),
};

/** provider 側でタイトルが空のまま同期された予定。フォールバック文言が出る。 */
export const UntitledEvent: Story = {
  render: () => (
    <DayColumn>
      <Ghosts events={[ghost({ id: 'a', title: null })]} />
    </DayColumn>
  ),
};

/** カレンダー名が無い接続（primary のみ等）。時刻だけを出す。 */
export const WithoutCalendarName: Story = {
  render: () => (
    <DayColumn>
      <Ghosts events={[ghost({ id: 'a', calendarName: null })]} />
    </DayColumn>
  ),
};

/** 5 日以上を並べるビューでは詳細行を落とす。 */
export const Compact: Story = {
  render: () => (
    <DayColumn>
      <Ghosts events={[ghost({ id: 'a' })]} compact />
    </DayColumn>
  ),
};

/**
 * 実時間では重ならない短い予定でも、最小描画高さの分だけ近ければ別カラムへ分ける。
 * 同じカラムに積むと、最小高さまで拡張されたカードが次の予定の開始位置へ食い込んで見える。
 */
export const AdjacentShortEvents: Story = {
  render: () => (
    <DayColumn fromHour={10} hours={1}>
      <Ghosts
        events={[
          ghost({ id: 'a', title: '朝会', startDate: at(10, 0), endDate: at(10, 10) }),
          ghost({ id: 'b', title: '1on1', startDate: at(10, 10), endDate: at(10, 20) }),
        ]}
      />
    </DayColumn>
  ),
};

/** 短い予定は最小高さで潰れない。 */
export const ShortEvent: Story = {
  render: () => (
    <DayColumn>
      <Ghosts
        events={[ghost({ id: 'a', title: '15 分の同期', startDate: at(10), endDate: at(10, 15) })]}
      />
    </DayColumn>
  ),
};

/** 前日から続く予定は 0:00 から、翌日へ続く予定は 24:00 で切る。 */
export const CrossingMidnight: Story = {
  render: () => (
    <DayColumn fromHour={0} hours={4}>
      <Ghosts
        events={[
          ghost({ id: 'a', title: '夜通しの遠征', startDate: at(22, 0, -1), endDate: at(3) }),
        ]}
      />
    </DayColumn>
  ),
};

/**
 * ghost と自分の Plan が同じ時刻に重なるケース。
 *
 * ghost は timeblocks より先に描かれ、plan が上に乗る。plan 側が `bg-transparent` なので、
 * ghost に塗りを敷くと plan の背景として透けてしまう — ここで飲まれていないことを目で見る。
 */
export const BehindPlanCard: Story = {
  render: () => (
    <DayColumn>
      <Ghosts
        events={[ghost({ id: 'a', title: '外部の予定', startDate: at(10), endDate: at(11, 30) })]}
      />
      <PlanLaneCard
        event={{
          id: 'plan-1',
          title: 'Deep Work',
          note: null,
          activityId: null,
          startDate: at(10, 15),
          endDate: at(11, 15),
          displayStartDate: at(10, 15),
          displayEndDate: at(11, 15),
          duration: 60,
          status: 'upcoming',
        }}
        position={{ top: 10.25 * HOUR_HEIGHT, height: 60, left: 0, width: 38 }}
        activityName="Deep Work"
        interactive={false}
      />
    </DayColumn>
  ),
};

/** モバイル Week の「予定」表示ではレーンが全幅になる。「記録」表示では ghost を描かない。 */
export const LaneDisplayModes: Story = {
  render: () => (
    <div className="flex gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">both（38%）</p>
        <DayColumn hours={3}>
          <Ghosts events={[ghost({ id: 'a' })]} />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">plan（100%）</p>
        <DayColumn hours={3}>
          <Ghosts events={[ghost({ id: 'b' })]} laneWidthPercent={100} />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">record（描かない）</p>
        <DayColumn hours={3}>
          <Ghosts events={[ghost({ id: 'c' })]} laneWidthPercent={0} />
        </DayColumn>
      </div>
    </div>
  ),
};

/**
 * 変換可能な ghost（#1985）。カード全体がクリック対象になり、隅に dismiss アイコンが出る。
 * Plan / Record どちらに変換されるかは呼び出し側（`useConvertGhostEvent`）が判定するため、
 * このカード自体は onConvert を呼ぶだけ。
 */
export const Convertible: Story = {
  args: { onConvert: fn(), onDismiss: fn() },
  render: (args) => (
    <DayColumn>
      <Ghosts events={[]} />
      <ExternalEventCard
        event={ghost({ id: 'convertible' })}
        position={{
          top: 10 * HOUR_HEIGHT,
          height: 60,
          left: 0,
          width: 38,
          displayStartDate: at(10),
          displayEndDate: at(11),
        }}
        onConvert={args.onConvert}
        onDismiss={args.onDismiss}
      />
    </DayColumn>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const convert = await canvas.findByRole('button', { name: /週次ミーティング/ });
    await expect(convert).toBeVisible();
    await userEvent.tab();
    await expect(convert).toHaveFocus();
    await expect(getComputedStyle(convert).boxShadow).toContain('inset');
    const bounds = convert.getBoundingClientRect();
    await expect(
      canvasElement.ownerDocument.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      ),
    ).toBe(convert);
    await userEvent.click(convert);
    await expect(args.onConvert).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Enter}');
    await expect(args.onConvert).toHaveBeenCalledTimes(2);
    await expect(args.onDismiss).not.toHaveBeenCalled();
  },
};

/** dismiss アイコンを押すと確認ダイアログが開く（design-system.md のアーカイブ相当、確認必須）。 */
export const DismissConfirm: Story = {
  render: () => (
    <DayColumn>
      <ExternalEventCard
        event={ghost({ id: 'dismissible' })}
        position={{
          top: 10 * HOUR_HEIGHT,
          height: 60,
          left: 0,
          width: 38,
          displayStartDate: at(10),
          displayEndDate: at(11),
        }}
        onConvert={fn()}
        onDismiss={fn()}
      />
    </DayColumn>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '非表示にする' }));

    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(within(dialog).getByText('この予定を非表示にしますか？')).toBeInTheDocument();
  },
};

export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-wrap gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">単独</p>
        <DayColumn hours={3}>
          <Ghosts events={[ghost({ id: 'p1' })]} />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">2 件重なり</p>
        <DayColumn hours={3}>
          <Ghosts
            events={[
              ghost({ id: 'p2a', title: '1on1', startDate: at(10), endDate: at(11, 30) }),
              ghost({ id: 'p2b', title: 'レビュー会', startDate: at(10, 30), endDate: at(12) }),
            ]}
          />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">3 件重なり</p>
        <DayColumn hours={3}>
          <Ghosts
            events={[
              ghost({ id: 'p3a', startDate: at(10), endDate: at(12) }),
              ghost({ id: 'p3b', title: '面談', startDate: at(10, 15), endDate: at(12) }),
              ghost({ id: 'p3c', title: '打ち合わせ', startDate: at(10, 30), endDate: at(12) }),
            ]}
          />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">タイトル無し</p>
        <DayColumn hours={3}>
          <Ghosts events={[ghost({ id: 'p4', title: null })]} />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">短い予定</p>
        <DayColumn hours={3}>
          <Ghosts events={[ghost({ id: 'p5', startDate: at(10), endDate: at(10, 15) })]} />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">compact</p>
        <DayColumn hours={3}>
          <Ghosts events={[ghost({ id: 'p6' })]} compact />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">plan と重なる</p>
        <DayColumn hours={3}>
          <Ghosts events={[ghost({ id: 'p7', startDate: at(10), endDate: at(11, 30) })]} />
          <PlanLaneCard
            event={{
              id: 'plan-2',
              title: 'Deep Work',
              note: null,
              activityId: null,
              startDate: at(10, 15),
              endDate: at(11, 15),
              displayStartDate: at(10, 15),
              displayEndDate: at(11, 15),
              duration: 60,
              status: 'upcoming',
            }}
            position={{ top: 10.25 * HOUR_HEIGHT, height: 60, left: 0, width: 38 }}
            activityName="Deep Work"
            interactive={false}
          />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">日跨ぎ</p>
        <DayColumn fromHour={0} hours={3}>
          <Ghosts
            events={[
              ghost({ id: 'p8', title: '夜通しの遠征', startDate: at(22, 0, -1), endDate: at(3) }),
            ]}
          />
        </DayColumn>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">変換可能（#1985）</p>
        <DayColumn hours={3}>
          <ExternalEventCard
            event={ghost({ id: 'p9' })}
            position={{
              top: 10 * HOUR_HEIGHT,
              height: 60,
              left: 0,
              width: 38,
              displayStartDate: at(10),
              displayEndDate: at(11),
            }}
            onConvert={fn()}
            onDismiss={fn()}
          />
        </DayColumn>
      </div>
    </div>
  ),
};
