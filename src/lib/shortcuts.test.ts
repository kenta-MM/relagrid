// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { claimShortcut, shortcutTarget } from './shortcuts';

afterEach(() => document.body.replaceChildren());
function eventFor(element: Element, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'F5',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  element.dispatchEvent(event);
  return event;
}

it.each(['input', 'textarea', 'select', 'div[contenteditable]'])(
  'does not take commands from unrelated %s fields',
  (selector) => {
    const element = document.createElement(selector.split('[')[0]);
    if (selector.includes('contenteditable')) element.setAttribute('contenteditable', 'true');
    document.body.append(element);
    expect(shortcutTarget(eventFor(element))).toBeNull();
    const editor = document.createElement('div');
    editor.className = 'sql-code-editor';
    document.body.append(editor);
    editor.append(element);
    expect(shortcutTarget(eventFor(element))).toBe(element);
  },
);

it('ignores composition, consumed events, AltGraph and events without an Element target', () => {
  expect(shortcutTarget(eventFor(document.body, { isComposing: true }))).toBeNull();
  expect(shortcutTarget(eventFor(document.body, { keyCode: 229 }))).toBeNull();
  const consumed = eventFor(document.body);
  consumed.preventDefault();
  expect(shortcutTarget(consumed)).toBeNull();
  const altGraph = eventFor(document.body);
  vi.spyOn(altGraph, 'getModifierState').mockImplementation((key) => key === 'AltGraph');
  expect(shortcutTarget(altGraph)).toBeNull();
  expect(shortcutTarget(new KeyboardEvent('keydown'))).toBeNull();
});

it.each(['dialog', 'alertdialog'])('blocks commands while a %s is open', (role) => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', role);
  dialog.dataset.state = 'open';
  document.body.append(dialog);
  expect(shortcutTarget(eventFor(document.body))).toBeNull();
  expect(shortcutTarget(eventFor(dialog))).toBeNull();
  dialog.remove();
  expect(shortcutTarget(eventFor(document.body))).toBe(document.body);
});

it('consumes repeated commands without executing the action twice or bubbling to the host', () => {
  const action = vi.fn();
  for (const repeat of [false, true]) {
    const event = new KeyboardEvent('keydown', { key: 'F5', repeat, cancelable: true });
    const stop = vi.spyOn(event, 'stopPropagation');
    claimShortcut(event, action);
    expect(event.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  }
  expect(action).toHaveBeenCalledOnce();
});
