import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleGlobalKeyDown, registerShortcut } from '@/lib/keyboard/shortcut-registry';

const unregisterCallbacks: Array<() => void> = [];

function registerTestShortcut({
  key = 'D',
  priority,
}: {
  key?: string;
  priority?: number;
} = {}) {
  const handler = vi.fn();
  unregisterCallbacks.push(
    registerShortcut({
      key,
      handler,
      description: `test shortcut ${key}`,
      ...(priority === undefined ? {} : { priority }),
    }),
  );
  return handler;
}

function dispatchKeyDown(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'd',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.addEventListener('keydown', handleGlobalKeyDown);
});

afterEach(() => {
  document.removeEventListener('keydown', handleGlobalKeyDown);
  for (const unregister of unregisterCallbacks.splice(0)) unregister();
  document.body.replaceChildren();
});

describe('shortcut-registry', () => {
  it('通常のkeydownでは最優先のhandlerだけを実行し、解除後は次のhandlerへ移る', () => {
    const lowPriorityHandler = registerTestShortcut({ priority: 0 });
    const highPriorityHandler = registerTestShortcut({ priority: 10 });

    dispatchKeyDown(document.body);
    expect(highPriorityHandler).toHaveBeenCalledOnce();
    expect(lowPriorityHandler).not.toHaveBeenCalled();

    const unregisterHighPriority = unregisterCallbacks.pop();
    unregisterHighPriority?.();
    dispatchKeyDown(document.body);
    expect(highPriorityHandler).toHaveBeenCalledOnce();
    expect(lowPriorityHandler).toHaveBeenCalledOnce();

    const unregisterLowPriority = unregisterCallbacks.pop();
    unregisterLowPriority?.();
    dispatchKeyDown(document.body);
    expect(highPriorityHandler).toHaveBeenCalledOnce();
    expect(lowPriorityHandler).toHaveBeenCalledOnce();
  });

  it('defaultPreventedまたはIME変換中のイベントを無視する', () => {
    const handler = registerTestShortcut();

    const preventedEvent = new KeyboardEvent('keydown', {
      key: 'd',
      bubbles: true,
      cancelable: true,
    });
    preventedEvent.preventDefault();
    document.body.dispatchEvent(preventedEvent);
    dispatchKeyDown(document.body, { isComposing: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl修飾キーを同じコンボとして扱う', () => {
    const handler = registerTestShortcut({ key: 'Cmd+K' });

    dispatchKeyDown(document.body, { key: 'k', metaKey: true });
    dispatchKeyDown(document.body, { key: 'k', ctrlKey: true });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('疑問符キーを処理し、入力中は無視する', () => {
    const handler = registerTestShortcut({ key: 'Shift+?' });
    const input = document.createElement('input');
    document.body.append(input);

    dispatchKeyDown(document.body, { key: '?', shiftKey: true });
    dispatchKeyDown(input, { key: '?', shiftKey: true });

    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')],
    [
      'contenteditable',
      () => {
        const element = document.createElement('div');
        element.setAttribute('contenteditable', 'true');
        return element;
      },
    ],
    [
      'textbox',
      () => {
        const element = document.createElement('div');
        element.setAttribute('role', 'textbox');
        return element;
      },
    ],
    [
      'combobox',
      () => {
        const element = document.createElement('button');
        element.setAttribute('role', 'combobox');
        return element;
      },
    ],
  ])('%s内のkeydownを無視する', (_name, createElement) => {
    const handler = registerTestShortcut();
    const element = createElement();
    document.body.append(element);

    dispatchKeyDown(element);

    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'menu', 'listbox'])('%s内のkeydownを無視する', (role) => {
    const handler = registerTestShortcut();
    const overlay = document.createElement('div');
    const child = document.createElement('button');
    overlay.setAttribute('role', role);
    overlay.append(child);
    document.body.append(overlay);

    dispatchKeyDown(child);

    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['input', 'dialog'])('%sのEscapeを適切な所有者へ渡す', (context) => {
    const handler = registerTestShortcut({ key: 'Escape' });
    const container =
      context === 'input' ? document.createElement('input') : document.createElement('div');
    const target = context === 'input' ? container : document.createElement('button');
    if (context === 'dialog') {
      container.setAttribute('role', 'dialog');
      container.append(target);
    }
    document.body.append(container);

    dispatchKeyDown(target, { key: 'Escape' });

    if (context === 'dialog') expect(handler).not.toHaveBeenCalled();
    else expect(handler).toHaveBeenCalledOnce();
  });

  it('focusがtriggerに残るpopoverでもEscapeを奪わない', () => {
    const handler = registerTestShortcut({ key: 'Escape' });
    const trigger = document.createElement('button');
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    document.body.append(trigger, overlay);
    dispatchKeyDown(trigger, { key: 'Escape' });
    expect(handler).not.toHaveBeenCalled();
    overlay.remove();
    dispatchKeyDown(trigger, { key: 'Escape' });
    expect(handler).toHaveBeenCalledOnce();
  });
});
