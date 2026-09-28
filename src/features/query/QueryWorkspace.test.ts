// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { queryStore } from '@/data/query-store';
import { QueryWorkspace } from './QueryWorkspace';
import type { QueryResult, QueryResultSet } from '@/domain/database';

vi.mock('@/data/query-store', () => ({
  queryStore: { load: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('./SqlEditor', () => ({
  SqlEditor: ({ value, onChange }: { value: string; onChange(value: string): void }) =>
    createElement(
      'div',
      { className: 'sql-code-editor' },
      createElement('textarea', {
        'aria-label': 'SQLクエリ',
        value,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      }),
    ),
}));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.mocked(queryStore.load).mockReset().mockResolvedValue([]);
  vi.mocked(queryStore.save).mockReset().mockResolvedValue(undefined);
});

it('saves the active query and all queries with shortcuts, then restores saved SQL', async () => {
  const { unmount } = await setup();
  const editor = () => screen.getByRole('textbox', { name: 'SQLクエリ' });
  const key = (key: string, shiftKey = false) =>
    fireEvent.keyDown(editor(), { key, ctrlKey: true, shiftKey });
  fireEvent.change(editor(), { target: { value: 'SELECT 11;' } });
  key('n');
  fireEvent.change(editor(), { target: { value: 'SELECT 22;' } });
  await act(async () => key('s'));
  expect(queryStore.save).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: 2, sql: 'SELECT 22;' }),
  ]);
  expect(screen.getByRole('tab', { name: 'Query 1' }).textContent).toContain('*');
  expect(screen.getByRole('tab', { name: 'Query 2' }).textContent).not.toContain('*');
  await act(async () => key('s', true));
  const saved = vi.mocked(queryStore.save).mock.calls.at(-1)![0];
  expect(saved.map((tab) => tab.sql)).toEqual(['SELECT 11;', 'SELECT 22;']);
  expect(saved[0]).not.toHaveProperty('result');
  fireEvent.change(editor(), { target: { value: 'SELECT unsaved;' } });
  unmount();
  vi.mocked(queryStore.load).mockResolvedValueOnce(saved);
  await setup();
  expect((editor() as HTMLTextAreaElement).value).toBe('SELECT 11;');
  click('Query 2', 'tab');
  expect((editor() as HTMLTextAreaElement).value).toBe('SELECT 22;');
  expect(screen.queryByRole('button', { name: '複製' })).toBeNull();
  expect(screen.queryByRole('button', { name: '比較' })).toBeNull();
  key('n');
  expect(screen.getByRole('tab', { name: 'Query 3' })).toBeTruthy();
});

it('keeps newer edits dirty during a save, and keeps them dirty on save failure', async () => {
  await setup();
  let finish!: () => void;
  vi.mocked(queryStore.save).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  click('保存');
  fireEvent.change(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    target: { value: 'SELECT 2;' },
  });
  await act(async () => finish());
  expect(screen.getByRole('tab', { name: 'Query 1' }).textContent).toContain('*');
  vi.mocked(queryStore.save).mockRejectedValueOnce(new Error('disk full'));
  await act(async () => click('保存'));
  expect(screen.getByRole('alert').textContent).toContain('disk full');
  expect(screen.getByRole('tab', { name: 'Query 1' }).textContent).toContain('*');
});

it('confirms closing the last dirty tab, while a saved tab closes without confirmation', async () => {
  await setup();
  const close = () =>
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
      key: 'w',
      ctrlKey: true,
    });
  close();
  expect(screen.getByRole('dialog').textContent).toContain('変更内容が失われます');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  click('Cancel');
  expect(screen.getByRole('tab', { name: 'Query 1' })).toBeTruthy();
  await act(async () => click('保存'));
  close();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Query 1' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Query 2' })).toBeTruthy();
  await act(async () => click('保存'));
  expect(
    vi
      .mocked(queryStore.save)
      .mock.calls.at(-1)![0]
      .map((tab) => tab.id),
  ).toEqual([1, 2]);
});

it('shows load failures and prevents overwriting unreadable saved queries', async () => {
  vi.mocked(queryStore.load).mockRejectedValueOnce(new Error('invalid file'));
  await setup();
  expect(screen.getByRole('alert').textContent).toContain('invalid file');
  expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    key: 's',
    ctrlKey: true,
  });
  expect(queryStore.save).not.toHaveBeenCalled();
});

it('retains disconnected saved SQL when a connection is selected', async () => {
  vi.mocked(queryStore.load).mockResolvedValueOnce([
    {
      id: 7,
      name: 'Query 7',
      sql: 'SELECT 77;',
      connectionId: 0,
      connectionLabel: '未接続',
      readOnly: true,
    },
  ]);
  const { props, rerender } = await setup();
  rerender(createElement(QueryWorkspace, { ...props, connectionId: 2, connectionLabel: 'DB B' }));
  expect((screen.getByRole('textbox', { name: 'SQLクエリ' }) as HTMLTextAreaElement).value).toBe(
    'SELECT 77;',
  );
  expect((screen.getByRole('button', { name: '実行' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => click('保存'));
  expect(queryStore.save).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: 7, sql: 'SELECT 77;', connectionId: 2 }),
  ]);
});

it('shares tab commands, confirmation and disabled execution with keyboard shortcuts', async () => {
  const pending = deferred();
  const { props } = await setup(vi.fn().mockReturnValue(pending.promise));
  const key = (key: string, extra = {}) =>
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), { key, ...extra });
  key('n', { ctrlKey: true });
  expect(screen.getByRole('tab', { name: 'Query 2' }).getAttribute('aria-selected')).toBe('true');
  key('Tab', { ctrlKey: true, shiftKey: true });
  expect(screen.getByRole('tab', { name: 'Query 1' }).getAttribute('aria-selected')).toBe('true');
  key('Tab', { ctrlKey: true });
  key('F5');
  key('Enter', { ctrlKey: true });
  key('F5', { repeat: true });
  expect(props.execute).toHaveBeenCalledTimes(1);
  key('w', { ctrlKey: true });
  expect(screen.getByRole('tab', { name: 'Query 2' })).toBeTruthy();
  await act(async () => key('F5', { shiftKey: true }));
  expect(props.cancel).toHaveBeenCalledWith(props.execute.mock.calls[0][2]);
  await act(async () => pending.reject(new Error('中断')));
  key('w', { ctrlKey: true });
  expect(screen.getByRole('dialog')).toBeTruthy();
  click('Cancel');
  key('w', { ctrlKey: true });
  click('OK');
  expect(screen.queryByRole('tab', { name: 'Query 2' })).toBeNull();
});

it('ignores composition, dialogs, other fields, repeats and hidden workspace', async () => {
  const { props, rerender } = await setup();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    key: 'F5',
    isComposing: true,
  });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    key: 'F5',
    keyCode: 229,
  });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    key: 'n',
    ctrlKey: true,
    repeat: true,
  });
  const input = document.createElement('input');
  document.body.append(input);
  fireEvent.keyDown(input, { key: 'F5' });
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('data-state', 'open');
  document.body.append(dialog);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), { key: 'F5' });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    key: 'n',
    ctrlKey: true,
  });
  dialog.remove();
  input.remove();
  expect(screen.queryByRole('tab', { name: 'Query 2' })).toBeNull();
  rerender(createElement(QueryWorkspace, { ...props, active: false }));
  fireEvent.keyDown(document.body, { key: 'F5' });
  expect(props.execute).not.toHaveBeenCalled();
});

it('switches results only when focused inside the results area', async () => {
  await setup(vi.fn().mockResolvedValue(multiResult()));
  await act(async () => click('実行'));
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    key: 'ArrowRight',
    altKey: true,
  });
  expect(screen.getByRole('tab', { name: '結果 1' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('region', { name: 'クエリ実行結果' }), {
    key: 'ArrowRight',
    altKey: true,
  });
  expect(
    screen.getByRole('tab', { name: '結果 2（省略あり）' }).getAttribute('aria-selected'),
  ).toBe('true');
  fireEvent.keyDown(screen.getByRole('region', { name: 'クエリ実行結果' }), {
    key: 'ArrowLeft',
    altKey: true,
  });
  expect(screen.getByRole('tab', { name: '結果 1' }).getAttribute('aria-selected')).toBe('true');
});
const result: QueryResult = {
  columns: ['value'],
  rows: [['A result']],
  elapsedMs: 1,
  affectedRows: 0,
  truncated: false,
  referencedTables: [],
};
function deferred() {
  let resolve!: (value: QueryResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<QueryResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(execute = vi.fn().mockResolvedValue(result)) {
  const props = {
    active: true,
    navigation: null,
    tables: [],
    selected: '',
    readOnly: true,
    busy: false,
    mode: 'mysql',
    connectionId: 1,
    connectionLabel: 'DB A',
    execute,
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const view = render(createElement(QueryWorkspace, props));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'SQLクエリ' })).toBeTruthy());
  return { props, ...view };
}
const click = (name: string, role = 'button') =>
  fireEvent.click(screen.getAllByRole(role, { name })[0]);

it('routes a delayed result to its owner and blocks duplicate execution before busy propagates', async () => {
  const pending = deferred();
  const execute = vi.fn().mockReturnValue(pending.promise);
  await setup(execute);
  click('実行');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    key: 'Enter',
    ctrlKey: true,
  });
  click('新規クエリ');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    key: 'Enter',
    ctrlKey: true,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByRole('button', { name: 'Query 1を閉じる' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => pending.resolve(result));
  expect(screen.queryByText('A result')).toBeNull();
  click('Query 1', 'tab');
  expect(screen.getByText('A result')).toBeTruthy();
  expect(execute.mock.calls[0][2]).toEqual(expect.any(String));
  click('Query 2', 'tab');
  click('Query 1', 'tab');
  expect(execute).toHaveBeenCalledTimes(1);
});

it('does not change another tab result view on failure and allows retry', async () => {
  const pending = deferred();
  const execute = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(result);
  await setup(execute);
  click('実行');
  click('新規クエリ');
  await act(async () => pending.reject(new Error('A failed')));
  expect(screen.getByRole('tab', { name: '結果' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('alert')).toBeNull();
  click('Query 1', 'tab');
  expect(screen.getByRole('alert').textContent).toBe('A failed');
  await act(async () => click('実行'));
  expect(screen.getByText('A result')).toBeTruthy();
});

it('retains SQL and results across connections and refuses execution on a different connection', async () => {
  const { props, rerender } = await setup();
  await act(async () => click('実行'));
  rerender(createElement(QueryWorkspace, { ...props, connectionId: 2, connectionLabel: 'DB B' }));
  expect(screen.getByRole('tab', { name: 'Query 2' }).getAttribute('aria-selected')).toBe('true');
  click('Query 1', 'tab');
  expect(screen.getByText('A result')).toBeTruthy();
  expect((screen.getByRole('button', { name: '実行' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQLクエリ' }), { key: 'F5' });
  expect(props.execute).toHaveBeenCalledTimes(1);
  rerender(createElement(QueryWorkspace, props));
  expect((screen.getByRole('button', { name: '実行' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('A result')).toBeTruthy();
});

it('waits for cancellation completion before closing and confirms unsaved SQL', async () => {
  const pending = deferred();
  const { props } = await setup(vi.fn().mockReturnValue(pending.promise));
  click('実行');
  await act(async () => click('中断'));
  expect(props.cancel).toHaveBeenCalledWith(props.execute.mock.calls[0][2]);
  click('新規クエリ');
  expect(
    (screen.getByRole('button', { name: 'Query 1を閉じる' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => pending.reject(new Error('中断しました')));
  click('Query 1を閉じる');
  click('Cancel');
  expect(screen.getByRole('tab', { name: 'Query 1' })).toBeTruthy();
  click('Query 1を閉じる');
  click('OK');
  expect(screen.queryByRole('tab', { name: 'Query 1' })).toBeNull();
});

it('captures SQL at start while allowing edits and keeps pagination per tab', async () => {
  const pending = deferred();
  const execute = vi.fn().mockReturnValue(pending.promise);
  await setup(execute);
  click('実行');
  fireEvent.change(screen.getByRole('textbox', { name: 'SQLクエリ' }), {
    target: { value: 'SELECT 2;' },
  });
  await act(async () =>
    pending.resolve({ ...result, rows: Array.from({ length: 30 }, (_, i) => [String(i)]) }),
  );
  expect(execute.mock.calls[0][0]).toBe('SELECT 1;');
  expect(screen.queryByRole('button', { name: '比較' })).toBeNull();
  click('次へ');
  expect(screen.getByText('2 / 3')).toBeTruthy();
  click('新規クエリ');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '100' } });
  click('Query 1', 'tab');
  expect(screen.getByText('2 / 3')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'SQLクエリ' }) as HTMLTextAreaElement).value).toBe(
    'SELECT 2;',
  );
});

function multiResult(error?: string): QueryResult {
  const sets: QueryResultSet[] = [
    {
      columns: ['a'],
      rows: Array.from({ length: 100 }, (_, i) => [`A-${i}`]),
      affectedRows: 0,
      truncated: false,
      complete: true,
    },
    {
      columns: ['b', 'extra'],
      rows: Array.from({ length: 100 }, (_, i) => [`B-${i}`, 'different']),
      affectedRows: 0,
      truncated: true,
      complete: true,
    },
    { columns: ['empty_column'], rows: [], affectedRows: 0, truncated: false, complete: true },
    { columns: [], rows: [], affectedRows: 4, truncated: false, complete: true },
  ];
  return { ...result, ...sets[0], resultSets: sets, affectedRows: 4, error };
}

it('keeps each result page, scroll and selection across editor switches without executing again', async () => {
  const execute = vi.fn().mockResolvedValue(multiResult());
  const { container } = await setup(execute);
  await act(async () => click('実行'));
  click('次へ');
  const scroll = container.querySelector('.query-result-scroll')!;
  fireEvent.scroll(scroll, { target: { scrollTop: 75, scrollLeft: 20 } });
  click('結果 2（省略あり）', 'tab');
  expect(screen.getByText('B-0')).toBeTruthy();
  expect(screen.queryByText('A-10')).toBeNull();
  expect(scroll.scrollTop).toBe(0);
  click('新規クエリ');
  click('Query 1', 'tab');
  expect(
    screen.getByRole('tab', { name: '結果 2（省略あり）' }).getAttribute('aria-selected'),
  ).toBe('true');
  click('結果 1', 'tab');
  expect(screen.getByText('A-10')).toBeTruthy();
  expect(scroll.scrollTop).toBe(75);
  expect(scroll.scrollLeft).toBe(20);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('distinguishes empty table metadata and updates and exports only the selected result', async () => {
  await setup(vi.fn().mockResolvedValue(multiResult()));
  await act(async () => click('実行'));
  click('結果 3', 'tab');
  expect(screen.getByRole('columnheader', { name: 'empty_column' })).toBeTruthy();
  expect(screen.getByText('結果は0件です')).toBeTruthy();
  click('更新 4', 'tab');
  expect(screen.getByText('4 行に影響しました')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'エクスポート' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  click('結果 2（省略あり）', 'tab');
  const create = vi.fn().mockReturnValue('blob:test');
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
  let filename = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filename = this.download;
  });
  click('エクスポート');
  expect(screen.getByRole('dialog').textContent).toContain('全件出力ではありません');
  click('保存先を選んで出力');
  await waitFor(() => expect(filename).toBe('Query 1-result-2.csv'));
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(create.mock.calls[0][0]);
  });
  expect(text).toContain('"b","extra"');
  expect(text).toContain('B-99');
  expect(text).not.toContain('A-0');
  vi.unstubAllGlobals();
});

it('shows partial results with failure status and clears old results when re-executed', async () => {
  const pending = deferred();
  await setup(
    vi
      .fn()
      .mockResolvedValueOnce(multiResult('文5で失敗しました'))
      .mockReturnValueOnce(pending.promise),
  );
  await act(async () => click('実行'));
  expect(screen.getByRole('alert').textContent).toContain('実行全体は失敗');
  expect(screen.getByText('実行エラー')).toBeTruthy();
  expect(screen.getByText('A-0')).toBeTruthy();
  click('実行');
  expect(screen.queryByText('A-0')).toBeNull();
  expect(screen.queryByRole('tab', { name: '結果 1' })).toBeNull();
  await act(async () => pending.resolve(result));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('A result')).toBeTruthy();
});
