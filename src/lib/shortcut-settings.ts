import { useSyncExternalStore } from 'react';

export const shortcutDefinitions = {
  search: ['テーブル・カラムを検索', '/'],
  sidebarOpen: ['サイドバーを開く', 'Mod+B'],
  sidebarClose: ['サイドバーを閉じる', 'Mod+B'],
  inspector: ['詳細パネルの開閉', 'Mod+Alt+B'],
  relations: ['リレーション画面', 'Mod+1'],
  sql: ['SQL画面', 'Mod+2'],
  switchMode: ['画面を切り替え', 'Mod+Shift+M'],
  newQuery: ['新規クエリ', 'Mod+T'],
  closeQuery: ['クエリを閉じる', 'Mod+W'],
  nextQuery: ['次のクエリ', 'Mod+Tab'],
  previousQuery: ['前のクエリ', 'Mod+Shift+Tab'],
  run: ['SQL全文を実行', 'F5'],
  runAlternate: ['SQL全文を実行（代替キー）', 'Mod+Enter'],
  stop: ['SQL実行を中断', 'Shift+F5'],
  previousResult: ['前の結果（結果内）', 'Alt+ArrowLeft'],
  nextResult: ['次の結果（結果内）', 'Alt+ArrowRight'],
} as const;
export type ShortcutId = keyof typeof shortcutDefinitions;
export type Shortcuts = Record<ShortcutId, string>;
export const shortcutIds = Object.keys(shortcutDefinitions) as ShortcutId[];
export const defaultShortcuts = Object.fromEntries(
  shortcutIds.map((id) => [id, shortcutDefinitions[id][1]]),
) as Shortcuts;
const storageKey = 'relagrid.shortcuts.v1';
export function shortcutConflict(values: Shortcuts): string | undefined {
  for (const [index, id] of shortcutIds.entries()) {
    const other = shortcutIds
      .slice(0, index)
      .find(
        (other) =>
          values[id] &&
          values[id] === values[other] &&
          ![id, other].every((key) => key === 'sidebarOpen' || key === 'sidebarClose'),
      );
    if (other)
      return `${shortcutDefinitions[id][0]}と${shortcutDefinitions[other][0]}に同じキーが設定されています。`;
  }
}
function readShortcuts(): Shortcuts {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    const values = { ...defaultShortcuts };
    for (const id of shortcutIds) if (typeof saved[id] === 'string') values[id] = saved[id];
    return shortcutConflict(values) ? defaultShortcuts : values;
  } catch {
    return defaultShortcuts;
  }
}
let shortcuts = readShortcuts();
const listeners = new Set<() => void>();
export function useShortcuts() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => shortcuts,
  );
}
export function saveShortcuts(values: Shortcuts) {
  localStorage.setItem(storageKey, JSON.stringify(values));
  shortcuts = { ...values };
  listeners.forEach((listener) => listener());
}
export function keyBinding(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
) {
  if (['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Unidentified'].includes(event.key)) return '';
  const key =
    event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [
    ...(event.ctrlKey || event.metaKey ? ['Mod'] : []),
    ...(event.altKey ? ['Alt'] : []),
    ...(event.shiftKey ? ['Shift'] : []),
    key,
  ].join('+');
}
export function matchesShortcut(event: KeyboardEvent, binding: string) {
  return !!binding && keyBinding(event) === binding;
}
export function shortcutLabel(binding: string) {
  return binding.replace('Mod+', 'Ctrl/Cmd+').replaceAll('+', ' + ') || '未設定';
}
export function shortcutAria(binding: string) {
  if (!binding) return undefined;
  return binding.includes('Mod+')
    ? `${binding.replace('Mod+', 'Control+')} ${binding.replace('Mod+', 'Meta+')}`
    : binding;
}
