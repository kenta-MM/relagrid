// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

afterEach(cleanup);

it('opens the connection menu without connecting and deletes the right-clicked entry', () => {
  const select = vi.fn();
  const remove = vi.fn();
  render(
    <Sidebar
      snapshot={{ tables: [], relationships: [] }}
      selected=""
      query=""
      onQueryChange={vi.fn()}
      searchInputRef={createRef<HTMLInputElement>()}
      onRefresh={vi.fn()}
      connections={[
        { id: 1, database: 'first', host: 'localhost', port: 3306 },
        { id: 2, database: 'second', host: 'localhost', port: 3306, group: 'Development' },
      ]}
      connectionGroups={['Development']}
      onAddGroup={vi.fn()}
      onMoveConnection={vi.fn()}
      onRemoveConnection={remove}
      activeConnectionId={1}
      connectionError=""
      onSelectConnection={select}
      mode="mysql"
      busy={false}
      readOnly
      onSelect={vi.fn()}
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
    />,
  );
  const entry = screen.getByRole('button', { name: 'second' });
  fireEvent.contextMenu(entry, { clientX: 50, clientY: 80 });
  expect(select).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(entry);
  fireEvent.keyDown(entry, { key: 'F10', shiftKey: true });
  fireEvent.click(screen.getByRole('menuitem', { name: '削除' }));
  expect(remove).toHaveBeenCalledWith(2);
  expect(screen.queryByRole('menu')).toBeNull();
});
