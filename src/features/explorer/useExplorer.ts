import { useCallback, useRef, useState } from 'react';
import { demoGateway, demoSnapshot } from '@/data/demo';
import { mysqlGateway } from '@/data/tauri-gateway';
import { DEMO_CONNECTION_ID } from '@/domain/database';
import type {
  ConnectionConfig,
  ConnectionEntry,
  DatabaseGateway,
  Preview,
  SchemaSnapshot,
} from '@/domain/database';
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
  const [readOnly, setReadOnly] = useState(true);
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [connectionGroups, setConnectionGroups] = useState<string[]>([]);
  const [demoGroup, setDemoGroup] = useState<string | undefined>();
  const [activeConnectionId, setActiveConnectionId] = useState<number | null>(null);
  const [connectionError, setConnectionError] = useState('');
  // Credentials are kept only in memory for reconnecting during this app session.
  const connectionConfigs = useRef(new Map<number, ConnectionConfig>());
  const nextConnectionId = useRef(1);
  const [sessionId, setSessionId] = useState(0);
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
  function addConnectionGroup(name: string) {
    const group = name.trim();
    if (!group) return;
    setConnectionGroups((current) => (current.includes(group) ? current : [...current, group]));
  }
  function moveConnection(id: number, name?: string) {
    if (operationInFlight.current) return;
    const group = name?.trim() || undefined;
    if (group && !connectionGroups.includes(group)) return;
    if (id === DEMO_CONNECTION_ID) {
      setDemoGroup(group);
      return;
    }
    const config = connectionConfigs.current.get(id);
    if (!config) return;
    connectionConfigs.current.set(id, { ...config, group });
    setConnections((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, group } : entry)),
    );
  }
  async function connect(config: ConnectionConfig, existingId?: number) {
    if (!beginOperation()) throw new Error('実行中の操作が完了するまでお待ちください。');
    try {
      const next = await mysqlGateway.connect(config);
      const id = existingId ?? nextConnectionId.current++;
      const group = config.group?.trim() || undefined;
      if (group) addConnectionGroup(group);
      connectionConfigs.current.set(id, { ...config, group });
      if (existingId === undefined) {
        setConnections((current) => [
          ...current,
          {
            id,
            database: config.database,
            group,
            host: config.host,
            port: config.port,
          },
        ]);
      }
      setActiveConnectionId(id);
      setConnectionError('');
      gateway.current = mysqlGateway;
      setMode('mysql');
      setDatabase(config.database);
      setReadOnly(config.readOnly ?? true);
      setSessionId((value) => value + 1);
      accept(next);
      log(
        `MySQL 接続完了 · ${next.tables.length} tables / ${next.relationships.length} relationships`,
      );
    } finally {
      endOperation();
    }
  }
  async function selectConnection(id: number) {
    if (operationInFlight.current || id === activeConnectionId) return;
    const config = connectionConfigs.current.get(id);
    if (!config) return;
    setConnectionError('');
    try {
      await connect(config, id);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      setConnectionError(message);
      log(message, true);
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
      setActiveConnectionId(null);
      setConnectionError('');
      setDatabase('SalesDB');
      setReadOnly(true);
      setSessionId((value) => value + 1);
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
  async function execute(sql: string, explain = false, executionId?: string) {
    if (!beginOperation()) throw new Error('実行中の操作が完了するまでお待ちください。');
    try {
      return await gateway.current.execute(sql, explain, executionId);
    } finally {
      // A writable statement may have changed data even if its response failed.
      if (!readOnly && !explain) {
        previewsByTable.current.clear();
        invalidatePreview();
      }
      endOperation();
    }
  }
  return {
    cancel: async (executionId: string) => {
      await gateway.current.cancel?.(executionId);
    },
    demoGroup,
    connectionGroups,
    addConnectionGroup,
    moveConnection,
    connections,
    activeConnectionId,
    connectionError,
    selectConnection,
    execute,
    readOnly,
    sessionId,
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
