import { useCallback, useEffect, useRef, useState } from 'react';
import { connectionStore, type SavedConnections } from '@/data/connection-store';
import { mysqlGateway } from '@/data/tauri-gateway';
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
  const [snapshot, setSnapshot] = useState<SchemaSnapshot>({ tables: [], relationships: [] });
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'disconnected' | 'mysql'>('disconnected');
  const [database, setDatabase] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [connectionGroups, setConnectionGroups] = useState<string[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<number | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [loading, setLoading] = useState(true);
  const storageReady = useRef(false);
  const groupsRef = useRef<string[]>([]);
  // Plaintext credentials exist only in memory; the native store encrypts them on disk.
  const connectionConfigs = useRef(new Map<number, ConnectionConfig>());
  const nextConnectionId = useRef(1);
  const [sessionId, setSessionId] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const gateway = useRef<DatabaseGateway>(mysqlGateway);
  // Cache belongs to this connection/schema session and never persists to disk.
  const previewsByTable = useRef(new Map<string, Preview>());
  const revision = useRef(0);
  const operationInFlight = useRef(false);
  const disconnecting = useRef(false);
  const operationVersion = useRef(0);
  const operationIsRead = useRef(false);
  const readRevision = useRef(0);
  const readCount = useRef(0);
  const [readBusy, setReadBusy] = useState(false);
  function beginRead() {
    readCount.current++;
    setReadBusy(true);
    return readRevision.current;
  }
  function endRead() {
    readCount.current--;
    setReadBusy(readCount.current > 0);
  }
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
  useEffect(() => {
    let cancelled = false;
    void connectionStore
      .load()
      .then((data) => {
        if (cancelled) return;
        connectionConfigs.current = new Map(
          data.connections.map(({ id, group, config }) => [
            id,
            { ...config, group: group ?? undefined },
          ]),
        );
        nextConnectionId.current = Math.max(0, ...data.connections.map(({ id }) => id)) + 1;
        groupsRef.current = data.groups;
        setConnectionGroups(data.groups);
        setConnections(
          data.connections.map(({ id, group, config }) => ({
            id,
            group: group ?? undefined,
            host: config.host,
            port: config.port,
            database: config.database,
          })),
        );
        storageReady.current = true;
      })
      .catch((error) => {
        if (cancelled) return;
        const message = String(error instanceof Error ? error.message : error);
        setConnectionError(message);
        log(message, true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [log]);
  function storedData(
    configs = connectionConfigs.current,
    groups = groupsRef.current,
  ): SavedConnections {
    return {
      groups,
      connections: [...configs].map(([id, config]) => ({ id, group: config.group, config })),
    };
  }
  async function persist(data: SavedConnections) {
    if (!storageReady.current)
      throw new Error(
        '接続設定を読み込めなかったため、保存できません。既存ファイルを確認してください。',
      );
    await connectionStore.save(data);
  }
  function reportStorageError(error: unknown) {
    const message =
      '接続設定の保存に失敗しました: ' + String(error instanceof Error ? error.message : error);
    setConnectionError(message);
    log(message, true);
  }
  // A ref gates operations synchronously, before React updates disabled buttons.
  function beginOperation(isRead = false) {
    if (loading || operationInFlight.current) return false;
    operationInFlight.current = true;
    operationIsRead.current = isRead;
    setBusy(true);
    return ++operationVersion.current;
  }
  function endOperation(version: number) {
    if (version !== operationVersion.current || disconnecting.current) return;
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
  async function addConnectionGroup(name: string) {
    const group = name.trim();
    if (!group || groupsRef.current.includes(group)) return;
    const operation = beginOperation();
    if (!operation) return;
    try {
      const groups = [...groupsRef.current, group];
      await persist(storedData(connectionConfigs.current, groups));
      groupsRef.current = groups;
      setConnectionGroups(groups);
      setConnectionError('');
    } catch (error) {
      reportStorageError(error);
    } finally {
      endOperation(operation);
    }
  }
  async function moveConnection(id: number, name?: string) {
    const group = name?.trim() || undefined;
    if (group && !groupsRef.current.includes(group)) return;
    const config = connectionConfigs.current.get(id);
    if (!config) return;
    const operation = beginOperation();
    if (!operation) return;
    try {
      const configs = new Map(connectionConfigs.current);
      configs.set(id, { ...config, group });
      await persist(storedData(configs));
      connectionConfigs.current = configs;
      setConnections((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, group } : entry)),
      );
      setConnectionError('');
    } catch (error) {
      reportStorageError(error);
    } finally {
      endOperation(operation);
    }
  }
  async function connect(config: ConnectionConfig, existingId?: number) {
    const operation = beginOperation(true);
    if (!operation) throw new Error('実行中の操作が完了するまでお待ちください。');
    const request = beginRead();
    try {
      const next = await mysqlGateway.connect(config);
      if (request !== readRevision.current) throw new Error('読み込みを中断しました。');
      const id = existingId ?? nextConnectionId.current++;
      const group = config.group?.trim() || undefined;
      if (group && !groupsRef.current.includes(group)) {
        groupsRef.current = [...groupsRef.current, group];
        setConnectionGroups(groupsRef.current);
      }
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
      try {
        await persist(storedData());
      } catch (error) {
        reportStorageError(error);
      }
    } finally {
      endRead();
      endOperation(operation);
    }
  }
  async function selectConnection(id: number) {
    if (operationInFlight.current || id === activeConnectionId) return;
    const config = connectionConfigs.current.get(id);
    if (!config) return;
    setConnectionError('');
    const request = readRevision.current;
    try {
      await connect(config, id);
    } catch (error) {
      if (request !== readRevision.current) return;
      const message = String(error instanceof Error ? error.message : error);
      setConnectionError(message);
      log(message, true);
    }
  }
  async function refresh() {
    if (mode !== 'mysql') return;
    const operation = beginOperation(true);
    if (!operation) return;
    invalidatePreview();
    const request = beginRead();
    try {
      const next = await gateway.current.refresh();
      if (request !== readRevision.current) return;
      accept(next);
      log(`スキーマを更新しました · ${next.tables.length} tables`);
    } catch (error) {
      if (request === readRevision.current) log(String(error), true);
    } finally {
      endRead();
      endOperation(operation);
    }
  }
  async function disconnect() {
    if (loading || disconnecting.current || (operationInFlight.current && !operationIsRead.current))
      return;
    disconnecting.current = true;
    const operation = ++operationVersion.current;
    operationInFlight.current = true;
    setBusy(true);
    readRevision.current++;
    revision.current++;
    try {
      await gateway.current.disconnect();
      setMode('disconnected');
      setActiveConnectionId(null);
      setConnectionError('');
      setDatabase('');
      setReadOnly(true);
      setSessionId((value) => value + 1);
      accept({ tables: [], relationships: [] });
      log('接続を切断しました');
    } catch (error) {
      log(String(error), true);
    } finally {
      disconnecting.current = false;
      endOperation(operation);
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
    const readRequest = beginRead();
    try {
      const result = await gateway.current.preview(table);
      if (request !== revision.current || readRequest !== readRevision.current) return;
      previewsByTable.current.set(table.id, result);
      setPreview(result);
      log(`${table.name} · ${result.rows.length} 件をプレビュー`);
    } catch (error) {
      if (request === revision.current) {
        setPreviewError(String(error));
        log(String(error), true);
      }
    } finally {
      endRead();
      if (request === revision.current) setPreviewBusy(false);
    }
  }
  async function execute(sql: string, explain = false, executionId?: string) {
    if (mode !== 'mysql') throw new Error('データベースに接続してください。');
    const operation = beginOperation();
    if (!operation) throw new Error('実行中の操作が完了するまでお待ちください。');
    try {
      return await gateway.current.execute(sql, explain, executionId);
    } finally {
      // A writable statement may have changed data even if its response failed.
      if (!readOnly && !explain) {
        previewsByTable.current.clear();
        invalidatePreview();
      }
      endOperation(operation);
    }
  }
  return {
    readBusy,
    cancelReads: async () => {
      try {
        await gateway.current.cancelReads?.();
      } catch (error) {
        log('読み込みの中断要求に失敗しました: ' + String(error), true);
        throw error;
      }
    },
    cancel: async (executionId: string) => {
      await gateway.current.cancel?.(executionId);
    },
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
    busy: busy || loading,
    preview,
    previewBusy,
    previewError,
    logs,
    connect,
    refresh,
    disconnect,
    browse,
    clearLogs: () => setLogs([]),
  };
}
