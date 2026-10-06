// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BottomPanel } from './BottomPanel';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(),
  Channel: class {},
}));
afterEach(cleanup);
const props = {
  tab: 'preview',
  onTab: vi.fn(),
  logs: [],
  preview: null,
  previewBusy: false,
  error: '',
  mode: 'mysql',
  busy: false,
  sessionId: 'a',
  connectionLabel: 'dev:3306 / db',
  onClear: vi.fn(),
  table: { id: 'db.target', schema: 'db', name: 'target', estimatedRows: null, columns: [] },
};

it('disables exports during a connection change and discards the old source dialog', () => {
  const { rerender } = render(<BottomPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'テーブル全件をCSV出力' }));
  expect(screen.getByRole('dialog').textContent).toContain('dev:3306 / db');
  rerender(<BottomPanel {...props} busy />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'テーブル全件をCSV出力' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  rerender(<BottomPanel {...props} sessionId="b" connectionLabel="prod:3306 / db" />);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'テーブル全件をCSV出力' }));
  expect(screen.getByRole('dialog').textContent).toContain('prod:3306 / db');
});

it('invalidates a dialog on reconnect even when table names are identical', () => {
  const { rerender } = render(<BottomPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'テーブル全件をCSV出力' }));
  rerender(<BottomPanel {...props} sessionId="reconnected" />);
  expect(screen.queryByRole('dialog')).toBeNull();
});
