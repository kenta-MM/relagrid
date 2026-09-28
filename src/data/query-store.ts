import { invoke, isTauri } from '@tauri-apps/api/core';

export interface SavedQuery {
  id: number;
  name: string;
  sql: string;
  connectionId: number;
  connectionLabel: string;
  readOnly: boolean;
}

export const queryStore = {
  load: (): Promise<SavedQuery[]> => (isTauri() ? invoke('load_queries') : Promise.resolve([])),
  save: (data: SavedQuery[]): Promise<void> =>
    isTauri()
      ? invoke('save_queries', { data })
      : Promise.reject(new Error('クエリのファイル保存はデスクトップ版で利用できます。')),
};
