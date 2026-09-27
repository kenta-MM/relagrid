// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useExplorer } from './useExplorer';
import { demoSnapshot } from '../../../tests/fixtures/demo';
import { connectionStore } from '@/data/connection-store';
import { mysqlGateway } from '@/data/tauri-gateway';
import type { Preview, SchemaSnapshot } from '@/domain/database';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.spyOn(connectionStore, 'load').mockResolvedValue({ connections: [], groups: [] });
  vi.spyOn(connectionStore, 'save').mockResolvedValue();
  vi.spyOn(mysqlGateway, 'refresh').mockResolvedValue(demoSnapshot);
  vi.spyOn(mysqlGateway, 'disconnect').mockResolvedValue();
});
async function readyExplorer() {
  const hook = renderHook(useExplorer);
  await waitFor(() => expect(hook.result.current.busy).toBe(false));
  return hook;
}
async function connectedExplorer() {
  const hook = await readyExplorer();
  const connect = vi.spyOn(mysqlGateway, 'connect').mockResolvedValueOnce(demoSnapshot);
  await act(async () => {
    await hook.result.current.connect(config);
  });
  connect.mockClear();
  act(() => hook.result.current.select('sales.Order'));
  return hook;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const config = {
  host: '127.0.0.1',
  port: 3306,
  username: 'reader',
  password: '',
  database: 'sales',
};

describe('explorer request coordination', () => {
  it('restores saved credentials and groups on startup and connects only on selection', async () => {
    const saved = { ...config, password: 'restored-secret', readOnly: false };
    vi.mocked(connectionStore.load).mockResolvedValue({
      groups: ['本番', '空のグループ'],
      connections: [{ id: 42, group: '本番', config: saved }],
    });
    const connect = vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
    const { result } = await readyExplorer();
    expect(result.current.activeConnectionId).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(result.current.connectionGroups).toEqual(['本番', '空のグループ']);
    expect(result.current.connections[0]).not.toHaveProperty('password');
    await act(async () => {
      await result.current.selectConnection(42);
    });
    expect(connect).toHaveBeenCalledWith({ ...saved, group: '本番' });
    await act(async () => {
      await result.current.connect(config);
    });
    expect(result.current.activeConnectionId).toBe(43);
    expect(connectionStore.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connections: expect.arrayContaining([expect.objectContaining({ id: 43 })]),
      }),
    );
  });
  it('does not overwrite settings after a failed startup read', async () => {
    vi.mocked(connectionStore.load).mockRejectedValue(new Error('復号できません'));
    vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
    const { result } = await readyExplorer();
    expect(result.current.connectionError).toContain('復号できません');
    await act(async () => {
      await result.current.connect(config);
    });
    expect(result.current.mode).toBe('mysql');
    expect(result.current.connectionError).toContain('保存に失敗');
    expect(connectionStore.save).not.toHaveBeenCalled();
  });
  it('reports save failures and keeps group moves uncommitted', async () => {
    vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
    const { result } = await readyExplorer();
    await act(async () => {
      await result.current.connect(config);
    });
    await act(async () => {
      await result.current.addConnectionGroup('開発');
    });
    vi.mocked(connectionStore.save).mockRejectedValue(new Error('disk full'));
    await act(async () => {
      await result.current.moveConnection(1, '開発');
    });
    expect(result.current.connections[0].group).toBeUndefined();
    expect(result.current.connectionError).toContain('disk full');
    expect(result.current.busy).toBe(false);
  });
  it('does not save failed connections and blocks changes while loading', async () => {
    const load = deferred<{ connections: []; groups: [] }>();
    vi.mocked(connectionStore.load).mockReturnValue(load.promise);
    const connect = vi.spyOn(mysqlGateway, 'connect').mockRejectedValue(new Error('Access denied'));
    const { result } = renderHook(useExplorer);
    await act(async () => {
      await expect(result.current.connect(config)).rejects.toThrow('実行中');
    });
    expect(connect).not.toHaveBeenCalled();
    await act(async () => {
      load.resolve({ connections: [], groups: [] });
    });
    await act(async () => {
      await expect(result.current.connect(config)).rejects.toThrow('Access denied');
    });
    expect(connectionStore.save).not.toHaveBeenCalled();
  });
  it('starts empty without connecting to a sample database', async () => {
    const connect = vi.spyOn(mysqlGateway, 'connect');
    const { result } = await readyExplorer();
    expect(result.current.mode).toBe('disconnected');
    expect(result.current.snapshot.tables).toEqual([]);
    expect(result.current.connections).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.addConnectionGroup('テスト');
    });
    expect(result.current.connectionGroups).toEqual(['テスト']);
  });
  it('moves connections into and out of groups without reconnecting and retains empty groups', async () => {
    const connect = vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
    const { result } = await readyExplorer();
    await act(async () => {
      await result.current.connect({ ...config, group: '本番環境' });
    });
    const first = result.current.activeConnectionId!;
    await act(async () => {
      await result.current.connect({ ...config, database: 'local' });
    });
    const active = result.current.activeConnectionId!;
    const session = result.current.sessionId;
    await act(async () => {
      await result.current.moveConnection(active, '本番環境');
    });
    expect(result.current.connections[1].group).toBe('本番環境');
    await act(async () => {
      await result.current.moveConnection(first);
      await result.current.moveConnection(active);
    });
    expect(result.current.connections.every((entry) => !entry.group)).toBe(true);
    expect(result.current.connectionGroups).toEqual(['本番環境']);
    expect(result.current.activeConnectionId).toBe(active);
    expect(result.current.sessionId).toBe(session);
    expect(connect).toHaveBeenCalledTimes(2);
    await act(async () => {
      await result.current.selectConnection(first);
    });
    expect(connect).toHaveBeenLastCalledWith({ ...config, group: undefined });
    expect(result.current.connections[0].group).toBeUndefined();
  });
  it('retains grouped and ungrouped connections and reconnects without duplicating entries', async () => {
    const connect = vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
    vi.spyOn(mysqlGateway, 'disconnect').mockResolvedValue();
    const { result } = await readyExplorer();
    await act(async () => {
      await result.current.connect({ ...config, group: ' 本番環境 ', readOnly: false });
    });
    const first = result.current.activeConnectionId!;
    await act(async () => {
      await result.current.connect({ ...config, database: 'billing', group: '本番環境' });
    });
    await act(async () => {
      await result.current.connect({ ...config, database: 'local', group: '  ' });
    });
    expect(result.current.connections.map((entry) => entry.group)).toEqual([
      '本番環境',
      '本番環境',
      undefined,
    ]);
    expect(result.current.connections[0]).not.toHaveProperty('password');
    await act(async () => {
      await result.current.selectConnection(first);
    });
    expect(connect).toHaveBeenLastCalledWith({ ...config, group: '本番環境', readOnly: false });
    expect(result.current.connections).toHaveLength(3);
    expect(result.current.activeConnectionId).toBe(first);
    expect(result.current.readOnly).toBe(false);
    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.activeConnectionId).toBeNull();
    expect(result.current.connections).toHaveLength(3);
    await act(async () => {
      await result.current.selectConnection(first);
    });
    expect(result.current.mode).toBe('mysql');
  });

  it('preserves the active connection when switching to another connection fails', async () => {
    const connect = vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
    const { result } = await readyExplorer();
    await act(async () => {
      await result.current.connect(config);
    });
    const first = result.current.activeConnectionId!;
    await act(async () => {
      await result.current.connect({ ...config, database: 'billing' });
    });
    const active = result.current.activeConnectionId;
    connect.mockRejectedValueOnce(new Error('Connection unavailable'));
    await act(async () => {
      await result.current.selectConnection(first);
    });
    expect(result.current.activeConnectionId).toBe(active);
    expect(result.current.database).toBe('billing');
    expect(result.current.connectionError).toBe('Connection unavailable');
    expect(result.current.connections).toHaveLength(2);
  });
  it('retains the active connection mode on failure and resets it on disconnect', async () => {
    vi.spyOn(mysqlGateway, 'connect')
      .mockResolvedValueOnce(demoSnapshot)
      .mockRejectedValueOnce(new Error('failed'));
    vi.spyOn(mysqlGateway, 'disconnect').mockResolvedValue();
    const { result } = await readyExplorer();
    await act(async () => {
      await result.current.connect({ ...config, readOnly: false });
    });
    expect(result.current.readOnly).toBe(false);
    const sessionId = result.current.sessionId;
    await act(async () => {
      await expect(result.current.connect({ ...config, readOnly: true })).rejects.toThrow();
    });
    expect(result.current.readOnly).toBe(false);
    expect(result.current.sessionId).toBe(sessionId);
    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.readOnly).toBe(true);
    expect(result.current.sessionId).toBeGreaterThan(sessionId);
  });
  it('blocks reconnect and refresh while SQL runs and releases the lock on error', async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(mysqlGateway, 'execute').mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const refresh = vi.spyOn(mysqlGateway, 'refresh');
    const { result } = await connectedExplorer();
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.execute('SELECT 1').catch((error) => error);
    });
    await act(async () => {
      await result.current.refresh();
      await expect(result.current.connect(config)).rejects.toThrow('実行中');
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);
    await act(async () => {
      reject(new Error('SQL failed'));
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });
  it('restores each table preview without fetching again and replaces it on explicit reload', async () => {
    const order = { columns: ['order_id'], rows: [['1052']] };
    const customer = { columns: ['customer_id'], rows: [['7']] };
    const updatedOrder = { columns: ['order_id'], rows: [['1053']] };
    const fetchPreview = vi
      .spyOn(mysqlGateway, 'preview')
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce(customer)
      .mockResolvedValueOnce(updatedOrder);
    const { result } = await connectedExplorer();
    await act(async () => {
      await result.current.browse();
    });
    act(() => result.current.select('sales.Customer'));
    expect(result.current.preview).toBeNull();
    await act(async () => {
      await result.current.browse();
    });
    act(() => result.current.select('sales.Order'));
    expect(result.current.preview).toBe(order);
    act(() => result.current.select('sales.Customer'));
    expect(result.current.preview).toBe(customer);
    expect(fetchPreview).toHaveBeenCalledTimes(2);
    act(() => result.current.select('sales.Order'));
    await act(async () => {
      await result.current.browse();
    });
    act(() => result.current.select('sales.Customer'));
    act(() => result.current.select('sales.Order'));
    expect(result.current.preview).toBe(updatedOrder);
    expect(fetchPreview).toHaveBeenCalledTimes(3);
  });

  it('also retains successful empty previews', async () => {
    const empty = { columns: ['order_id'], rows: [] };
    vi.spyOn(mysqlGateway, 'preview').mockResolvedValue(empty);
    const { result } = await connectedExplorer();
    await act(async () => {
      await result.current.browse();
    });
    act(() => result.current.select('sales.Customer'));
    act(() => result.current.select('sales.Order'));
    expect(result.current.preview).toBe(empty);
  });

  it.each(['refresh', 'connect', 'disconnect'] as const)(
    'clears cached previews after %s succeeds',
    async (operation) => {
      vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
      vi.spyOn(mysqlGateway, 'preview').mockResolvedValue({
        columns: ['order_id'],
        rows: [['1052']],
      });
      const { result } = await connectedExplorer();
      await act(async () => {
        await result.current.browse();
      });
      await act(async () => {
        if (operation === 'connect') await result.current.connect(config);
        else await result.current[operation]();
      });
      act(() => result.current.select('sales.Customer'));
      act(() => result.current.select('sales.Order'));
      expect(result.current.preview).toBeNull();
    },
  );

  it('retains cached previews when a connection attempt fails', async () => {
    const cached = { columns: ['order_id'], rows: [['1052']] };
    vi.spyOn(mysqlGateway, 'preview').mockResolvedValue(cached);
    vi.spyOn(mysqlGateway, 'connect').mockRejectedValue(new Error('Access denied'));
    const { result } = await connectedExplorer();
    await act(async () => {
      await result.current.browse();
    });
    await act(async () => {
      await expect(result.current.connect(config)).rejects.toThrow('Access denied');
    });
    act(() => result.current.select('sales.Customer'));
    act(() => result.current.select('sales.Order'));
    expect(result.current.preview).toBe(cached);
  });

  it('discards a delayed preview after selecting a different table', async () => {
    const response = deferred<Preview>();
    vi.spyOn(mysqlGateway, 'preview').mockReturnValue(response.promise);
    const { result } = await connectedExplorer();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.browse();
    });
    act(() => {
      result.current.select('sales.Customer');
    });
    await act(async () => {
      response.resolve({ columns: ['order_id'], rows: [['1052']] });
      await pending;
    });
    expect(result.current.selected).toBe('sales.Customer');
    expect(result.current.preview).toBeNull();
    expect(result.current.previewBusy).toBe(false);
    act(() => result.current.select('sales.Order'));
    expect(result.current.preview).toBeNull();
  });

  it('preserves the current snapshot on a failed connection', async () => {
    vi.spyOn(mysqlGateway, 'connect').mockRejectedValue(new Error('Access denied'));
    const { result } = await readyExplorer();
    await act(async () => {
      await expect(result.current.connect(config)).rejects.toThrow('Access denied');
    });
    expect(result.current.mode).toBe('disconnected');
    expect(result.current.snapshot).toEqual({ tables: [], relationships: [] });
    expect(result.current.busy).toBe(false);
  });

  it('serializes schema operations even before disabled buttons render', async () => {
    const response = deferred<SchemaSnapshot>();
    const connect = vi.spyOn(mysqlGateway, 'connect').mockReturnValue(response.promise);
    const refresh = vi.spyOn(mysqlGateway, 'refresh');
    const { result } = await readyExplorer();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.connect(config);
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      response.resolve(demoSnapshot);
      await pending;
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe('mysql');
    expect(result.current.busy).toBe(false);
  });
});
