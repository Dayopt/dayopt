import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalEventPosition } from '../../../../../lib/external-event-layout';

import { ExternalEventCard } from './ExternalEventCard';

vi.mock('next-intl', () => ({
  useLocale: () => 'ja',
  useTranslations: () => (key: string) => key,
}));

const startDate = new Date('2026-07-14T09:00:00.000Z');
const endDate = new Date('2026-07-14T10:00:00.000Z');

const event = {
  id: 'ghost-1',
  title: '週次ミーティング',
  calendarName: 'Work',
  startDate,
  endDate,
};

function position(overrides: Partial<ExternalEventPosition> = {}): ExternalEventPosition {
  return {
    top: 0,
    left: 0,
    width: 38,
    height: 60,
    displayStartDate: startDate,
    displayEndDate: endDate,
    ...overrides,
  };
}

describe('ExternalEventCard', () => {
  it('重複数が多く width が小さくても幅が 0 以下にならない', () => {
    // 4px の固定減算を素直に適用すると width 2% は負値になり、カードが不可視化する。
    render(<ExternalEventCard event={event} position={position({ width: 2 })} />);

    const card = screen.getByText('週次ミーティング').closest('[data-external-event-card]');
    expect(card).not.toBeNull();
    expect(card).toHaveStyle({ minWidth: '4px' });
  });

  it('時刻表示は event の生の開始・終了ではなく position のクリップ済み表示時刻を使う', () => {
    // event 自体は前日 22:00 開始でも、当日カラムでは 00:00 開始として描く。
    const rawStart = new Date('2026-07-13T22:00:00.000Z');
    const clippedStart = new Date(2026, 6, 14, 0, 0);
    const clippedEnd = new Date(2026, 6, 14, 2, 0);

    render(
      <ExternalEventCard
        event={{ ...event, startDate: rawStart }}
        position={position({ displayStartDate: clippedStart, displayEndDate: clippedEnd })}
      />,
    );

    expect(screen.getByText('00:00–02:00', { exact: false })).toBeInTheDocument();
  });
});

describe('ExternalEventCard — 変換（onConvert）', () => {
  it('同名の外部予定を時刻とカレンダー名で区別できる', () => {
    render(
      <>
        <ExternalEventCard
          event={event}
          position={position({
            displayStartDate: new Date(2026, 6, 14, 9),
            displayEndDate: new Date(2026, 6, 14, 10),
          })}
          onConvert={vi.fn()}
        />
        <ExternalEventCard
          event={{ ...event, calendarName: 'Personal' }}
          position={position({
            displayStartDate: new Date(2026, 6, 14, 11),
            displayEndDate: new Date(2026, 6, 14, 12),
          })}
          onConvert={vi.fn()}
        />
      </>,
    );
    expect(
      screen.getByRole('button', { name: /週次ミーティング, 09:00–10:00 · Work/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /週次ミーティング, 11:00–12:00 · Personal/ }),
    ).toBeInTheDocument();
  });

  it('onConvert 未指定なら role=button を持たない読み取り専用のまま', () => {
    render(<ExternalEventCard event={event} position={position()} />);

    expect(screen.queryByRole('button', { name: /週次ミーティング/ })).not.toBeInTheDocument();
  });

  it('onConvert 指定時、カード全体クリックで呼ばれる', async () => {
    const user = userEvent.setup();
    const onConvert = vi.fn();
    render(<ExternalEventCard event={event} position={position()} onConvert={onConvert} />);

    await user.click(screen.getByRole('button', { name: /週次ミーティング/ }));

    expect(onConvert).toHaveBeenCalledTimes(1);
  });

  it('Enter / Space キーでも変換を呼ぶ', async () => {
    const user = userEvent.setup();
    const onConvert = vi.fn();
    render(<ExternalEventCard event={event} position={position()} onConvert={onConvert} />);

    const card = screen.getByRole('button', { name: /週次ミーティング/ });
    card.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onConvert).toHaveBeenCalledTimes(2);
  });

  it('onConvert 指定時のみ sr-only の hint テキストを添える', () => {
    const { rerender } = render(<ExternalEventCard event={event} position={position()} />);
    expect(screen.queryByText('convert.hint', { exact: false })).not.toBeInTheDocument();

    rerender(<ExternalEventCard event={event} position={position()} onConvert={vi.fn()} />);
    expect(screen.getByText('convert.hint', { exact: false })).toBeInTheDocument();
  });
});

describe('ExternalEventCard — dismiss', () => {
  it('onDismiss 未指定なら dismiss アイコンを描かない', () => {
    render(<ExternalEventCard event={event} position={position()} onConvert={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'dismiss.ariaLabel' })).not.toBeInTheDocument();
  });

  it('dismiss アイコン押下で確認ダイアログが開く。確認で onDismiss を呼ぶ', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    render(
      <ExternalEventCard
        event={event}
        position={position()}
        onConvert={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'dismiss.ariaLabel' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('dismiss.confirmTitle');

    await user.click(within(dialog).getByRole('button', { name: 'dismiss.confirmLabel' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss のキーボード操作は変換を発火せず確認を開く', async () => {
    const user = userEvent.setup();
    const onConvert = vi.fn();
    render(
      <ExternalEventCard
        event={event}
        position={position()}
        onConvert={onConvert}
        onDismiss={vi.fn()}
      />,
    );
    const dismiss = screen.getByRole('button', { name: 'dismiss.ariaLabel' });
    expect(dismiss.parentElement?.closest('button, [role="button"]')).toBeNull();
    dismiss.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('dismiss.confirmTitle');
    expect(onConvert).not.toHaveBeenCalled();
  });

  it('dismiss アイコンのクリックはカードの onConvert を発火させない', async () => {
    const user = userEvent.setup();
    const onConvert = vi.fn();
    render(
      <ExternalEventCard
        event={event}
        position={position()}
        onConvert={onConvert}
        onDismiss={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'dismiss.ariaLabel' }));

    expect(onConvert).not.toHaveBeenCalled();
  });
});
