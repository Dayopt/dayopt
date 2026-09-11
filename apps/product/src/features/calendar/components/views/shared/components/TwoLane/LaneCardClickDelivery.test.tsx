/**
 * クリックの届け先は 1 つ。
 *
 * 掴めるカードでは pointer の状態機械が「動いていない＝クリック」と判断して届ける
 * （EVENT_CLICK）ので、同じ gesture の末尾に来るブラウザの click は捨てる。
 * 2 経路とも届けると、開閉のトグルが打ち消し合って押しても何も起きない（2026-09-10）。
 *
 * 判定は mousedown 時点で固定する。mouseup で状態機械が開いた直後に click が来るため、
 * click 時点の isActive を見ると「開いているカードの click」と誤認して通してしまう。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlanEvent, RecordEvent } from '@/features/timeblock';

import type { TwoLanePosition } from '../../../../../lib/two-lane-layout';

import { PlanLaneCard } from './PlanLaneCard';
import { RecordLaneCard } from './RecordLaneCard';

const position: TwoLanePosition = { top: 0, left: 0, width: 50, height: 60 };
const startDate = new Date('2026-07-14T09:00:00.000Z');
const endDate = new Date('2026-07-14T10:00:00.000Z');

const plan: PlanEvent = {
  id: 'plan-1',
  title: 'Plan',
  note: null,
  activityId: null,
  startDate,
  endDate,
  displayStartDate: startDate,
  displayEndDate: endDate,
  duration: 60,
  status: 'upcoming',
};

const record: RecordEvent = {
  id: 'record-1',
  title: 'Record',
  note: null,
  activityId: null,
  startDate,
  endDate,
  displayStartDate: startDate,
  displayEndDate: endDate,
  duration: 60,
};

const AT = { clientX: 10, clientY: 10, button: 0 };

describe('lane card のクリック配送', () => {
  it('掴めるカード: mousedown → click の gesture は状態機械が届けるので click は捨てる', () => {
    const onClick = vi.fn();
    render(
      <PlanLaneCard
        event={plan}
        position={position}
        activityName="確認"
        onClick={onClick}
        onPointerDown={vi.fn()}
      />,
    );
    const card = screen.getByRole('button', { name: '確認' });

    fireEvent.mouseDown(card, AT);
    fireEvent.click(card, AT);

    expect(onClick).not.toHaveBeenCalled();
  });

  it('詳細を開いているカード: 状態機械が握らないので click が届ける（閉じられる）', () => {
    const onClick = vi.fn();
    render(
      <PlanLaneCard
        event={plan}
        position={position}
        activityName="確認"
        isActive
        onClick={onClick}
        onPointerDown={vi.fn()}
      />,
    );
    const card = screen.getByRole('button', { name: '確認' });

    fireEvent.mouseDown(card, AT);
    fireEvent.click(card, AT);

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('キーボードの Enter は mousedown を伴わないので届ける', () => {
    const onClick = vi.fn();
    render(
      <PlanLaneCard
        event={plan}
        position={position}
        activityName="確認"
        onClick={onClick}
        onPointerDown={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: '確認' }), { key: 'Enter' });

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('掴めないカード（drag 無効）は状態機械を通らないので click が届ける', () => {
    const onClick = vi.fn();
    render(
      <RecordLaneCard
        event={record}
        position={position}
        activityName="確認"
        disableDrag
        onClick={onClick}
        onPointerDown={vi.fn()}
      />,
    );
    const card = screen.getByRole('button', { name: '確認' });

    fireEvent.mouseDown(card, AT);
    fireEvent.click(card, AT);

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('閾値ちょうど（5px）は状態機械が届けるので捨てる', () => {
    const onClick = vi.fn();
    render(
      <PlanLaneCard
        event={plan}
        position={position}
        activityName="確認"
        onClick={onClick}
        onPointerDown={vi.fn()}
      />,
    );
    const card = screen.getByRole('button', { name: '確認' });

    // pointer-up.ts は `> DRAG_THRESHOLD_PX` を「動いた」とするので 5px は click 扱い
    fireEvent.mouseDown(card, AT);
    fireEvent.click(card, { clientX: 15, clientY: 10, button: 0 });

    expect(onClick).not.toHaveBeenCalled();
  });

  it('動かしてから離した click（drag の末尾）は従来どおり届ける', () => {
    const onClick = vi.fn();
    render(
      <RecordLaneCard
        event={record}
        position={position}
        activityName="確認"
        onClick={onClick}
        onPointerDown={vi.fn()}
      />,
    );
    const card = screen.getByRole('button', { name: '確認' });

    fireEvent.mouseDown(card, AT);
    fireEvent.click(card, { clientX: 10, clientY: 60, button: 0 });

    expect(onClick).toHaveBeenCalledOnce();
  });
});
