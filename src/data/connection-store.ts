import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ConnectionConfig } from '@/domain/database';

export interface SavedConnections {
  connections: { id: number; group?: string; config: ConnectionConfig }[];
  groups: string[];
}

export const connectionStore = {
  load: (): Promise<SavedConnections> =>
    isTauri() ? invoke('load_connections') : Promise.resolve({ connections: [], groups: [] }),
  save: (data: SavedConnections): Promise<void> =>
    isTauri()
      ? invoke('save_connections', { data })
      : Promise.reject(new Error('接続設定の保存はデスクトップ版で利用できます。')),
};
