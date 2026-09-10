import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DockedInspectorPanel } from './DockedInspectorPanel';

function makeSlot() {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  return slot;
}

describe('DockedInspectorPanel', () => {
  it('renders nothing when no slot element is registered yet', () => {
    const { container } = render(
      <DockedInspectorPanel title="Work" slotElement={null}>
        <button type="button">Edit</button>
      </DockedInspectorPanel>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('portals its content into the slot element and exposes a non-modal region', () => {
    const slot = makeSlot();

    render(
      <DockedInspectorPanel title="Work" slotElement={slot}>
        <button type="button">Edit</button>
      </DockedInspectorPanel>,
    );

    const region = screen.getByRole('region', { name: 'Work' });
    expect(slot.contains(region)).toBe(true);
    expect(region).not.toHaveAttribute('aria-modal');
  });

  it('moves focus into the panel on open and restores it to the previously focused element on close', async () => {
    const slot = makeSlot();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <DockedInspectorPanel title="Work" slotElement={slot}>
        <button type="button">Edit</button>
      </DockedInspectorPanel>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus());

    unmount();

    expect(document.activeElement).toBe(trigger);
  });

  it('パネルの外を押したら閉じる', () => {
    const slot = makeSlot();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const onRequestClose = vi.fn();

    render(
      <DockedInspectorPanel title="Work" slotElement={slot} onRequestClose={onRequestClose}>
        <button type="button">Edit</button>
      </DockedInspectorPanel>,
    );

    fireEvent.pointerDown(outside);

    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('パネルの中を押しても閉じない', () => {
    const slot = makeSlot();
    const onRequestClose = vi.fn();

    render(
      <DockedInspectorPanel title="Work" slotElement={slot} onRequestClose={onRequestClose}>
        <button type="button">Edit</button>
      </DockedInspectorPanel>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Edit' }));

    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('カレンダーのブロックを押しても閉じない（開閉はカードの click が決める）', () => {
    const slot = makeSlot();
    const onRequestClose = vi.fn();

    render(
      <DockedInspectorPanel title="Work" slotElement={slot} onRequestClose={onRequestClose}>
        <button type="button">Edit</button>
      </DockedInspectorPanel>,
    );

    const card = document.createElement('div');
    card.setAttribute('data-entry-block', 'true');
    card.setAttribute('data-entry-id', 'plan-1');
    const label = document.createElement('span');
    card.appendChild(label);
    document.body.appendChild(card);

    // カードの中身を押した場合も含めて閉じない。ここで閉じると、後から走る click が
    // 開き直して「閉じてまた開く」になる
    fireEvent.pointerDown(label);

    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('パネル外の popover / メニュー / トーストと、組で動く印を持つ要素では閉じない', () => {
    const slot = makeSlot();
    const onRequestClose = vi.fn();

    render(
      <DockedInspectorPanel title="Work" slotElement={slot} onRequestClose={onRequestClose}>
        <button type="button">Edit</button>
      </DockedInspectorPanel>,
    );

    // 日付ピッカー（Radix popover）、メニュー、トーストはいずれも document.body 直下へ出る。
    // カレンダー上の選択ハイライトは自分で `data-inspector-keep-open` を付ける
    for (const attrs of [
      { 'data-radix-popper-content-wrapper': '' },
      { role: 'menu' },
      { 'data-sonner-toaster': '' },
      { 'data-inspector-keep-open': '' },
    ]) {
      const layer = document.createElement('div');
      for (const [name, value] of Object.entries(attrs)) layer.setAttribute(name, value);
      const inner = document.createElement('button');
      layer.appendChild(inner);
      document.body.appendChild(layer);

      fireEvent.pointerDown(inner);
    }

    expect(onRequestClose).not.toHaveBeenCalled();
  });
});
