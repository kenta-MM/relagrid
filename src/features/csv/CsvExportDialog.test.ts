// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CsvExportDialog } from './CsvExportDialog';
import { openCsvSink } from './export';

vi.mock('./export', async (original) => ({
  ...(await original<typeof import('./export')>()),
  openCsvSink: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const selection = {
  name: 'test.csv',
  label: '結果2',
  result: {
    columns: ['v'],
    rows: [['a'], ['b']],
    complete: false,
    truncated: true,
    affectedRows: 0,
  },
};
function start() {
  render(createElement(CsvExportDialog, { selection, close: vi.fn() }));
  fireEvent.click(screen.getByRole('button', { name: '保存先を選んで出力' }));
}
it('keeps cancellation visible until the in-flight write finishes and never commits', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sink = { write: vi.fn(() => pending), finish: vi.fn(), abort: vi.fn() };
  vi.mocked(openCsvSink).mockResolvedValue(sink);
  start();
  await waitFor(() => expect(sink.write).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: '中断' }));
  expect(screen.getByRole('status').textContent).toContain('中断しています');
  await act(async () => release());
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('出力を中断しました'),
  );
  expect(sink.finish).not.toHaveBeenCalled();
  expect(sink.abort).toHaveBeenCalledOnce();
});
it('reports a failed save and cleans up before allowing retry', async () => {
  const sink = {
    write: vi.fn().mockRejectedValue(new Error('空き容量がありません')),
    finish: vi.fn(),
    abort: vi.fn(),
  };
  vi.mocked(openCsvSink).mockResolvedValue(sink);
  start();
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('空き容量がありません'),
  );
  expect(sink.abort).toHaveBeenCalledOnce();
  expect(sink.finish).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '保存先を選んで出力' })).toBeTruthy();
});
it('handles cancelling the save dialog without starting a writer', async () => {
  vi.mocked(openCsvSink).mockResolvedValue(null);
  start();
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('保存を取り消しました'),
  );
});
