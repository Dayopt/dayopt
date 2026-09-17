import { MockWindow } from './MockWindow';

/**
 * PlanMock — タイムラインに時間ブロックが並んだ状態
 * ダミーデータ。後で実プロダクト画面に差し替える。
 */
export function PlanMock() {
  const hours = ['9:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];

  const blocks = [
    {
      top: '0%',
      height: '22%',
      label: 'Deep Work: Design System',
      duration: '2h',
      color: 'bg-primary/15 border-primary/30',
    },
    {
      top: '25%',
      height: '12%',
      label: 'Email & Slack',
      duration: '1h',
      color: 'bg-category-amber/15 border-category-amber/30',
    },
    {
      top: '40%',
      height: '10%',
      label: 'Lunch',
      duration: '45m',
      color: 'bg-container border-border',
    },
    {
      top: '53%',
      height: '22%',
      label: 'Code Review + PR',
      duration: '2h',
      color: 'bg-category-blue/15 border-category-blue/30',
    },
    {
      top: '78%',
      height: '15%',
      label: 'Weekly Reflection',
      duration: '1h',
      color: 'bg-category-green/15 border-category-green/30',
    },
  ];

  // ナビ項目は product の実際のサイドバー（navigation.sidebar.navigation）に合わせる
  const navItems = ['Calendar', 'Plan', 'Record', 'Tags', 'Review'];
  const nowPosition = '35%'; // 11:00 あたり

  return (
    <MockWindow>
      <div className="flex size-full select-none">
        {/* Sidebar — lg 以上で表示 */}
        <div className="bg-container border-border hidden w-44 shrink-0 flex-col border-r p-3 lg:flex">
          {/* Logo */}
          <div className="mb-4 flex items-center gap-2">
            <div className="bg-primary size-3 rounded-full" />
            <span className="text-foreground text-xs font-medium">Dayopt</span>
          </div>

          {/* Nav */}
          <div className="space-y-0.5">
            {navItems.map((item) => (
              <div
                key={item}
                className={`rounded-[4px] px-2 py-1 text-xs ${
                  item === 'Calendar'
                    ? 'bg-state-active text-state-active-foreground font-medium'
                    : 'text-muted-foreground'
                }`}
              >
                {item}
              </div>
            ))}
          </div>

          {/* 指標名は実在するものだけを出す（calendar.stats.overview.planAccuracy） */}
          <div className="border-border mt-auto border-t pt-3">
            <div className="text-muted-foreground mb-1 text-xs">Plan accuracy</div>
            <div className="text-foreground text-xl font-medium tabular-nums">87%</div>
            <div className="bg-muted mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
              <div className="bg-primary h-full rounded-full" style={{ width: '87%' }} />
            </div>
          </div>
        </div>

        {/* Main: Timeline */}
        <div className="flex flex-1 flex-col">
          {/* Header */}
          <div className="border-border flex items-center justify-between border-b px-4 py-2">
            <span className="text-foreground text-xs font-medium">Tuesday, Mar 17</span>
            <div className="flex gap-0.5">
              {['Day', 'Week'].map((view) => (
                <span
                  key={view}
                  className={`rounded-full px-2.5 py-0.5 text-xs ${
                    view === 'Day' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {view}
                </span>
              ))}
            </div>
          </div>

          {/* Timeline */}
          <div className="relative flex-1 overflow-hidden">
            {/* Time labels */}
            <div className="absolute inset-y-0 left-0 w-12">
              {hours.map((hour, i) => (
                <div
                  key={hour}
                  className="text-muted-foreground absolute right-2 text-xs tabular-nums"
                  style={{ top: `${(i / hours.length) * 100}%` }}
                >
                  {hour}
                </div>
              ))}
            </div>

            {/* Grid lines */}
            <div className="absolute inset-y-0 right-0 left-12">
              {hours.map((hour, i) => (
                <div
                  key={hour}
                  className="border-border absolute right-0 left-0 border-t"
                  style={{ top: `${(i / hours.length) * 100}%` }}
                />
              ))}
            </div>

            {/* Now indicator */}
            <div className="absolute right-0 left-0 z-10" style={{ top: nowPosition }}>
              <div className="flex items-center">
                <span className="bg-destructive text-destructive-foreground rounded-r px-1 py-px text-[10px] font-medium">
                  11:15
                </span>
                <div className="bg-destructive h-px flex-1" />
              </div>
            </div>

            {/* Time blocks */}
            <div className="absolute inset-y-0 right-3 left-14">
              {blocks.map((block) => (
                <div
                  key={block.label}
                  className={`absolute right-0 left-0 rounded-lg border px-3 py-1.5 ${block.color}`}
                  style={{ top: block.top, height: block.height }}
                >
                  <div className="flex items-start justify-between">
                    <span className="text-foreground text-xs font-medium">{block.label}</span>
                    <span className="text-foreground text-[10px]">{block.duration}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </MockWindow>
  );
}
