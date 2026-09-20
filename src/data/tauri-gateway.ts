import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DatabaseGateway, Preview, QueryResult, SchemaSnapshot } from '@/domain/database';
export const mysqlGateway: DatabaseGateway = {
  async connect(config) {
    if (!isTauri())
      throw new Error('MySQL接続はデスクトップ版で利用できます。npm run dev で起動してください。');
    return invoke<SchemaSnapshot>('connect_database', { config });
  },
  refresh: () => invoke<SchemaSnapshot>('refresh_schema'),
  preview: (table) => invoke<Preview>('preview_table', { tableId: table.id }),
  disconnect: () => invoke<void>('disconnect_database'),
  execute: (sql, explain = false) => invoke<QueryResult>('execute_query', { sql, explain }),
};
