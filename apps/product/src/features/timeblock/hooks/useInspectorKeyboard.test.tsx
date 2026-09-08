import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useInspectorKeyboard } from './useInspectorKeyboard';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function escape(target: EventTarget = document) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(event));
}

describe('useInspectorKeyboard', () => {
  it('closes the inspector only after its child overlay is gone', () => {
    const onClose = vi.fn();
    renderHook(() => useInspectorKeyboard({ isOpen: true, onClose }));
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    document.body.append(overlay);
    escape();
    expect(onClose).not.toHaveBeenCalled();
    overlay.remove();
    escape();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('respects an Escape already handled by a time input', () => {
    const onClose = vi.fn();
    renderHook(() => useInspectorKeyboard({ isOpen: true, onClose }));
    const input = document.createElement('input');
    input.addEventListener('keydown', (event) => event.preventDefault());
    document.body.append(input);
    escape(input);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not let a hidden overlay trap Escape', () => {
    const onClose = vi.fn();
    renderHook(() => useInspectorKeyboard({ isOpen: true, onClose }));
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.hidden = true;
    document.body.append(overlay);
    escape();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
