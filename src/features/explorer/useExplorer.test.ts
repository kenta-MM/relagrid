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
