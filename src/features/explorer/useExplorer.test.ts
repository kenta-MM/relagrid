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
