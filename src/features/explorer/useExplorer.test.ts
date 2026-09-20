// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExplorer } from './useExplorer';
import { demoGateway, demoSnapshot } from '@/data/demo';
import { mysqlGateway } from '@/data/tauri-gateway';
import type { Preview, SchemaSnapshot } from '@/domain/database';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  it('retains grouped and ungrouped connections and reconnects without duplicating entries', async () => {
    const connect = vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
    vi.spyOn(mysqlGateway, 'disconnect').mockResolvedValue();
    const { result } = renderHook(useExplorer);
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
      await result.current.useDemo();
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
    const { result } = renderHook(useExplorer);
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
    const { result } = renderHook(useExplorer);
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
      await result.current.useDemo();
    });
    expect(result.current.readOnly).toBe(true);
    expect(result.current.sessionId).toBeGreaterThan(sessionId);
  });
  it('blocks reconnect and refresh while SQL runs and releases the lock on error', async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(demoGateway, 'execute').mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const refresh = vi.spyOn(demoGateway, 'refresh');
    const { result } = renderHook(useExplorer);
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
      .spyOn(demoGateway, 'preview')
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce(customer)
      .mockResolvedValueOnce(updatedOrder);
    const { result } = renderHook(useExplorer);
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
    vi.spyOn(demoGateway, 'preview').mockResolvedValue(empty);
    const { result } = renderHook(useExplorer);
    await act(async () => {
      await result.current.browse();
    });
    act(() => result.current.select('sales.Customer'));
    act(() => result.current.select('sales.Order'));
    expect(result.current.preview).toBe(empty);
  });

  it.each(['refresh', 'connect', 'useDemo'] as const)(
    'clears cached previews after %s succeeds',
    async (operation) => {
      vi.spyOn(mysqlGateway, 'connect').mockResolvedValue(demoSnapshot);
      vi.spyOn(demoGateway, 'preview').mockResolvedValue({
        columns: ['order_id'],
        rows: [['1052']],
      });
      const { result } = renderHook(useExplorer);
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
    vi.spyOn(demoGateway, 'preview').mockResolvedValue(cached);
    vi.spyOn(mysqlGateway, 'connect').mockRejectedValue(new Error('Access denied'));
    const { result } = renderHook(useExplorer);
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
    vi.spyOn(demoGateway, 'preview').mockReturnValue(response.promise);
    const { result } = renderHook(useExplorer);
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
    const { result } = renderHook(useExplorer);
    await act(async () => {
      await expect(result.current.connect(config)).rejects.toThrow('Access denied');
    });
    expect(result.current.mode).toBe('demo');
    expect(result.current.snapshot).toBe(demoSnapshot);
    expect(result.current.busy).toBe(false);
  });

  it('serializes schema operations even before disabled buttons render', async () => {
    const response = deferred<SchemaSnapshot>();
    const connect = vi.spyOn(mysqlGateway, 'connect').mockReturnValue(response.promise);
    const refresh = vi.spyOn(demoGateway, 'refresh');
    const { result } = renderHook(useExplorer);
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
