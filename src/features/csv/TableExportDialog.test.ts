// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TableExportDialog } from './TableExportDialog';
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage?: (value: { rows: number }) => void;
  },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const table = {
  id: 'db.target',
  schema: 'db',
  name: 'target',
  estimatedRows: 9000,
  columns: [{ name: 'v', dataType: 'text', nullable: true, primaryKey: false }],
};
function start() {
  render(createElement(TableExportDialog, { table, close: vi.fn() }));
  fireEvent.click(screen.getByRole('button', { name: '保存先を選んで全件出力' }));
}
it('sends the selected table ID without SQL and reports actual rows rather than estimates', async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'begin_csv_export') return 'job' as never;
    const request = args as {
      tableId: string;
      progress: { onmessage(value: { rows: number }): void };
    };
    expect(command).toBe('export_table_csv');
    expect(request.tableId).toBe(table.id);
    expect(args).not.toHaveProperty('sql');
    request.progress.onmessage({ rows: 1200 });
    return 1205 as never;
  });
  start();
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('1205件の保存が完了'),
  );
  expect(screen.getByRole('status').textContent).not.toContain('9000');
});
it('cancels a pending save selection before any table read begins', async () => {
  let resolve!: (id: string) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === 'begin_csv_export'
      ? new Promise((done) => {
          resolve = done as (id: string) => void;
        })
      : Promise.resolve(undefined as never),
  );
  start();
  fireEvent.click(screen.getByRole('button', { name: '中断' }));
  await act(async () => resolve('job'));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('出力を中断しました'),
  );
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    'begin_csv_export',
    'abort_csv_export',
  ]);
});
it('cleans up a failed read and displays the record/column error', async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'begin_csv_export') return 'job' as never;
    if (command === 'export_table_csv') throw 'レコード4・列2で上限を超えました';
    return undefined as never;
  });
  start();
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('レコード4・列2'));
  expect(invoke).toHaveBeenCalledWith('abort_csv_export', { id: 'job' });
});
