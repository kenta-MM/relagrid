import { Activity, LoaderCircle, Table2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import type { Preview, Table } from '@/domain/database';
import { useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { TableExportDialog } from '@/features/csv/TableExportDialog';
import type { LogEntry } from './useExplorer';
interface Props {
  tab: string;
  onTab(tab: string): void;
  logs: LogEntry[];
  preview: Preview | null;
  previewBusy: boolean;
  error: string;
  tableName?: string;
  table?: Table;
  mode: string;
  onClear(): void;
}
export function BottomPanel({
  tab,
  onTab,
  logs,
  preview,
  previewBusy,
  error,
  tableName,
  table,
  mode,
  onClear,
}: Props) {
  const [exportTable, setExportTable] = useState<Table | null>(null);
  return (
    <Tabs value={tab} onValueChange={onTab} className="bottom-panel">
      <div className="bottom-tabs">
        <TabsList>
          <TabsTrigger value="activity">
            <Activity size={13} className="inline mr-2" />
            アクティビティ
          </TabsTrigger>
          <TabsTrigger value="preview">
            <Table2 size={13} className="inline mr-2" />
            データプレビュー
          </TabsTrigger>
        </TabsList>
        {tab === 'activity' ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            クリア
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="preview-caption">
              {tableName} · {mode === 'demo' ? 'サンプルデータ' : '最大100件 / 各値500文字まで'}
            </span>
            {mode !== 'demo' && isTauri() && table && (
              <Button variant="ghost" size="sm" onClick={() => setExportTable(table)}>
                テーブル全件をCSV出力
              </Button>
            )}
          </div>
        )}
      </div>
      <TabsContent value="activity" className="panel-scroll">
        <div className="log-list" role="log">
          {logs.map((log) => (
            <div className="log-row" key={log.id}>
              <span className={`log-dot ${log.error ? 'error' : ''}`} />
              <time>{log.time}</time>
              <span className={log.error ? 'text-red-300' : ''}>{log.message}</span>
            </div>
          ))}
          {!logs.length && <p className="muted">ログはありません。</p>}
        </div>
      </TabsContent>
      <TabsContent value="preview" className="panel-scroll">
        {previewBusy ? (
          <div className="preview-empty">
            <LoaderCircle size={18} className="animate-spin" />
            読み込み中…
          </div>
        ) : error ? (
          <p role="alert" className="error-message m-4">
            {error}
          </p>
        ) : preview ? (
          <table className="data-table">
            <thead>
              <tr>
                {preview.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((value, cell) => (
                    <td key={cell}>{value === null ? <em>NULL</em> : value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {!preview.rows.length && <caption>データはありません</caption>}
          </table>
        ) : (
          <div className="preview-empty">
            <Table2 size={20} />
            右側の「データを表示」からテーブルを確認できます。
          </div>
        )}
      </TabsContent>
      {exportTable && <TableExportDialog table={exportTable} close={() => setExportTable(null)} />}
    </Tabs>
  );
}
