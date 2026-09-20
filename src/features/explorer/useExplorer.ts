import { useCallback, useRef, useState } from 'react';
import { demoGateway, demoSnapshot } from '@/data/demo';
import { mysqlGateway } from '@/data/tauri-gateway';
import type { ConnectionConfig, DatabaseGateway, Preview, SchemaSnapshot } from '@/domain/database';
export interface LogEntry {
  id: number;
  time: string;
  message: string;
  error: boolean;
}
export function useExplorer() {
  const [snapshot, setSnapshot] = useState(demoSnapshot);
  const [selected, setSelected] = useState('sales.Order');
  const [mode, setMode] = useState<'demo' | 'mysql'>('demo');
  const [database, setDatabase] = useState('SalesDB');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 0,
      time: new Date().toLocaleTimeString('ja-JP'),
      message: 'デモスキーマを読み込みました · 7 tables / 6 relationships',
      error: false,
    },
  ]);
  const gateway = useRef<DatabaseGateway>(demoGateway);
  // Cache belongs to this connection/schema session and never persists to disk.
  const previewsByTable = useRef(new Map<string, Preview>());
  const revision = useRef(0);
  const operationInFlight = useRef(false);
  const logId = useRef(1);
  const log = useCallback((message: string, error = false) => {
    const entry = {
      id: logId.current++,
      time: new Date().toLocaleTimeString('ja-JP'),
      message,
      error,
    };
    setLogs((current) => [...current.slice(-99), entry]);
  }, []);
  // A ref gates operations synchronously, before React updates disabled buttons.
  function beginOperation() {
    if (operationInFlight.current) return false;
    operationInFlight.current = true;
    setBusy(true);
    return true;
  }
  function endOperation() {
    operationInFlight.current = false;
    setBusy(false);
  }
  function invalidatePreview() {
    revision.current++;
    setPreview(null);
    setPreviewBusy(false);
    setPreviewError('');
  }
  function select(id: string) {
    invalidatePreview();
    setSelected(id);
    setPreview(previewsByTable.current.get(id) ?? null);
  }
  function accept(next: SchemaSnapshot) {
    previewsByTable.current.clear();
    invalidatePreview();
    setSnapshot(next);
    setSelected((current) =>
      next.tables.some((t) => t.id === current) ? current : next.tables[0]?.id || '',
    );
  }
  async function connect(config: ConnectionConfig) {
    if (!beginOperation()) throw new Error('実行中の操作が完了するまでお待ちください。');
    try {
      const next = await mysqlGateway.connect(config);
      gateway.current = mysqlGateway;
      setMode('mysql');
      setDatabase(config.database);
      accept(next);
      log(
        `MySQL 接続完了 · ${next.tables.length} tables / ${next.relationships.length} relationships`,
      );
    } finally {
      endOperation();
    }
  }
  async function refresh() {
    if (!beginOperation()) return;
    invalidatePreview();
    try {
      const next = await gateway.current.refresh();
      accept(next);
      log(`スキーマを更新しました · ${next.tables.length} tables`);
    } catch (error) {
      log(String(error), true);
    } finally {
      endOperation();
    }
  }
  async function useDemo() {
    if (!beginOperation()) return;
    try {
      await gateway.current.disconnect();
      gateway.current = demoGateway;
      setMode('demo');
      setDatabase('SalesDB');
      accept(demoSnapshot);
      log('デモモードに切り替えました');
    } catch (error) {
      log(String(error), true);
    } finally {
      endOperation();
    }
  }
  async function browse() {
    if (operationInFlight.current) return;
    const table = snapshot.tables.find((t) => t.id === selected);
    if (!table) return;
    const request = ++revision.current;
    setPreviewBusy(true);
    setPreviewError('');
    setPreview(null);
    try {
      const result = await gateway.current.preview(table);
      if (request !== revision.current) return;
      previewsByTable.current.set(table.id, result);
      setPreview(result);
      log(`${table.name} · ${result.rows.length} 件をプレビュー`);
    } catch (error) {
      if (request === revision.current) {
        setPreviewError(String(error));
        log(String(error), true);
      }
    } finally {
      if (request === revision.current) setPreviewBusy(false);
    }
  }
  return {
    snapshot,
    selected,
    select,
    mode,
    database,
    busy,
    preview,
    previewBusy,
    previewError,
    logs,
    connect,
    refresh,
    useDemo,
    browse,
    clearLogs: () => setLogs([]),
  };
}
