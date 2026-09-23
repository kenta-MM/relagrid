// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryWorkspace } from './QueryWorkspace';
import type { QueryResult } from '@/domain/database';

vi.mock('./SqlEditor', () => ({
  SqlEditor: ({
    value,
    onChange,
    onRun,
  }: {
    value: string;
    onChange(value: string): void;
    onRun(): void;
  }) =>
    createElement('textarea', {
      'aria-label': 'SQLクエリ',
      value,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      onKeyDown: () => onRun(),
    }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
function setup(execute = vi.fn().mockResolvedValue(result)) {
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
  return { props, ...view };
}
const click = (name: string, role = 'button') =>
  fireEvent.click(screen.getAllByRole(role, { name })[0]);

it('routes a delayed result to its owner and blocks duplicate execution before busy propagates', async () => {
  const pending = deferred();
  const execute = vi.fn().mockReturnValue(pending.promise);
  setup(execute);
  click('実行');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  click('新規クエリ');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
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
  setup(execute);
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
  const { props, rerender } = setup();
  await act(async () => click('実行'));
  rerender(createElement(QueryWorkspace, { ...props, connectionId: 2, connectionLabel: 'DB B' }));
  expect(screen.getByRole('tab', { name: 'Query 2' }).getAttribute('aria-selected')).toBe('true');
  click('Query 1', 'tab');
  expect(screen.getByText('A result')).toBeTruthy();
  expect((screen.getByRole('button', { name: '実行' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole('textbox'));
  expect(props.execute).toHaveBeenCalledTimes(1);
  rerender(createElement(QueryWorkspace, props));
  expect((screen.getByRole('button', { name: '実行' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('A result')).toBeTruthy();
});

it('waits for cancellation completion before closing and confirms unsaved SQL', async () => {
  const pending = deferred();
  const { props } = setup(vi.fn().mockReturnValue(pending.promise));
  click('実行');
  await act(async () => click('中断'));
  expect(props.cancel).toHaveBeenCalledWith(props.execute.mock.calls[0][2]);
  click('新規クエリ');
  expect(
    (screen.getByRole('button', { name: 'Query 1を閉じる' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => pending.reject(new Error('中断しました')));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  click('Query 1を閉じる');
  expect(screen.getByRole('tab', { name: 'Query 1' })).toBeTruthy();
  confirm.mockReturnValue(true);
  click('Query 1を閉じる');
  expect(screen.queryByRole('tab', { name: 'Query 1' })).toBeNull();
});

it('captures SQL at start while allowing edits and keeps pagination per tab', async () => {
  const pending = deferred();
  const execute = vi.fn().mockReturnValue(pending.promise);
  setup(execute);
  click('実行');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'SELECT 2;' } });
  await act(async () =>
    pending.resolve({ ...result, rows: Array.from({ length: 30 }, (_, i) => [String(i)]) }),
  );
  expect(execute.mock.calls[0][0]).toBe('SELECT 1;');
  click('比較');
  expect(screen.getByText('SELECT 1;')).toBeTruthy();
  click('次へ');
  expect(screen.getByText('2 / 3')).toBeTruthy();
  click('新規クエリ');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '100' } });
  click('Query 1', 'tab');
  expect(screen.getByText('2 / 3')).toBeTruthy();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('SELECT 2;');
});

it('duplicates SQL without copying execution/results and retains the source connection', async () => {
  const { props, rerender } = setup();
  await act(async () => click('実行'));
  rerender(createElement(QueryWorkspace, { ...props, connectionId: 2, connectionLabel: 'DB B' }));
  click('Query 1', 'tab');
  click('複製');
  expect(screen.getByRole('tab', { name: 'Query 3' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('A result')).toBeNull();
  expect((screen.getByRole('button', { name: '実行' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/サイドバーでこの接続/).textContent).toContain('DB A');
});
