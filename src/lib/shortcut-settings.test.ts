// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const storageKey = 'relagrid.shortcuts.v1';
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['{broken', 'null', '{"run":"Mod+N"}'])(
  'recovers defaults from invalid or conflicting stored settings: %s',
  async (saved) => {
    localStorage.setItem(storageKey, saved);
    const { useShortcuts, defaultShortcuts } = await import('./shortcut-settings');
    const { result } = renderHook(useShortcuts);
    expect(result.current).toEqual(defaultShortcuts);
    expect(localStorage.getItem(storageKey)).toBe(saved);
  },
);

it('merges partial settings, ignores unknown/non-string fields and preserves disabled keys', async () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify({ run: 'F6', search: '', sql: 42, unknown: 'F7' }),
  );
  const { useShortcuts, defaultShortcuts } = await import('./shortcut-settings');
  const { result } = renderHook(useShortcuts);
  expect(result.current).toEqual({ ...defaultShortcuts, run: 'F6', search: '' });
});

it('notifies subscribers only after durable storage succeeds and permits retry', async () => {
  const { useShortcuts, saveShortcuts, defaultShortcuts } = await import('./shortcut-settings');
  const first = renderHook(useShortcuts);
  const second = renderHook(useShortcuts);
  const draft = { ...defaultShortcuts, run: 'F6' };
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  act(() => expect(() => saveShortcuts(draft)).toThrow('full'));
  expect(first.result.current).toEqual(defaultShortcuts);
  expect(second.result.current).toEqual(defaultShortcuts);
  expect(localStorage.getItem(storageKey)).toBeNull();
  act(() => saveShortcuts(draft));
  expect(write).toHaveBeenCalledTimes(2);
  expect(first.result.current.run).toBe('F6');
  expect(second.result.current.run).toBe('F6');
  draft.run = 'F7';
  expect(first.result.current.run).toBe('F6');
  expect(JSON.parse(localStorage.getItem(storageKey)!).run).toBe('F6');
});

it('allows the sidebar toggle and unassigned commands but rejects other collisions', async () => {
  const { shortcutConflict, defaultShortcuts, shortcutIds } = await import('./shortcut-settings');
  expect(shortcutConflict(defaultShortcuts)).toBeUndefined();
  expect(shortcutConflict({ ...defaultShortcuts, run: defaultShortcuts.newQuery })).toContain(
    '同じキー',
  );
  expect(
    shortcutConflict(
      Object.fromEntries(shortcutIds.map((id) => [id, ''])) as typeof defaultShortcuts,
    ),
  ).toBeUndefined();
});

it('normalizes platform modifiers, requires exact modifiers and exposes accessible labels', async () => {
  const { keyBinding, matchesShortcut, shortcutLabel, shortcutAria } =
    await import('./shortcut-settings');
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = new KeyboardEvent('keydown', { key: 's', [modifier]: true, shiftKey: true });
    expect(keyBinding(event)).toBe('Mod+Shift+S');
    expect(matchesShortcut(event, 'Mod+Shift+S')).toBe(true);
    expect(matchesShortcut(event, 'Mod+S')).toBe(false);
    expect(matchesShortcut(event, '')).toBe(false);
  }
  for (const key of ['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Unidentified'])
    expect(keyBinding(new KeyboardEvent('keydown', { key }))).toBe('');
  expect(keyBinding(new KeyboardEvent('keydown', { key: ' ', altKey: true }))).toBe('Alt+Space');
  expect(shortcutLabel('Mod+Shift+S')).toBe('Ctrl/Cmd + Shift + S');
  expect(shortcutLabel('')).toBe('未設定');
  expect(shortcutAria('Mod+S')).toBe('Control+S Meta+S');
  expect(shortcutAria('F5')).toBe('F5');
  expect(shortcutAria('')).toBeUndefined();
});
