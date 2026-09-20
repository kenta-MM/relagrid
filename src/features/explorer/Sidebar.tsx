import {
  ChevronDown,
  Database,
  Folder,
  Table2,
  Layers3,
  Plus,
  Sparkles,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConnectionEntry, SchemaSnapshot } from '@/domain/database';
interface Props {
  snapshot: SchemaSnapshot;
  selected: string;
  query: string;
  database: string;
  connections: ConnectionEntry[];
  activeConnectionId: number | null;
  connectionError: string;
  onSelectConnection(id: number): void;
  mode: string;
  busy: boolean;
  readOnly: boolean;
  onSelect(id: string): void;
  onConnect(): void;
  onDemo(): void;
}
export function Sidebar({
  snapshot,
  selected,
  query,
  database,
  connections,
  activeConnectionId,
  connectionError,
  onSelectConnection,
  mode,
  busy,
  readOnly,
  onSelect,
  onConnect,
  onDemo,
}: Props) {
  const tables = snapshot.tables.filter((table) =>
    `${table.name} ${table.schema} ${table.columns.map((c) => c.name).join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const schemas = [...new Set(tables.map((table) => table.schema))];
  const groups = new Map<string, ConnectionEntry[]>();
  for (const connection of connections) {
    if (!connection.group) continue;
    const entries = groups.get(connection.group) ?? [];
    entries.push(connection);
    groups.set(connection.group, entries);
  }
  function connectionItem(connection: ConnectionEntry) {
    const active = connection.id === activeConnectionId;
    return (
      <button
        key={connection.id}
        className={`connection-item ${active ? 'active' : ''}`}
        onClick={() => onSelectConnection(connection.id)}
        disabled={busy}
        aria-pressed={active}
        title={`${connection.database} · ${connection.host}:${connection.port}`}
      >
        <Database size={17} />
        <strong>{connection.database}</strong>
        {active && <span className="status-dot" />}
      </button>
    );
  }
  return (
    <aside className="sidebar">
      <div className="section-label">
        <span>
          <Database size={14} /> CONNECTIONS
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onConnect}
          disabled={busy}
          aria-label="接続を追加"
        >
          <Plus size={16} />
        </Button>
      </div>
      <nav className="connection-tree" aria-label="接続一覧">
        {mode === 'demo' && (
          <div className="connection-item active">
            <Database size={17} />
            <strong>{database}</strong>
            <span className="status-dot demo" />
          </div>
        )}
        {[...groups].map(([group, entries], index) => (
          <details className="connection-group" open key={group}>
            <summary title={group}>
              <ChevronDown size={13} />
              <span className={`group-dot group-color-${index % 6}`} />
              <span className="group-name">{group}</span>
              <span className="group-count">{entries.length}</span>
            </summary>
            <div className="connection-group-items">{entries.map(connectionItem)}</div>
          </details>
        ))}
        {connections.filter((connection) => !connection.group).map(connectionItem)}
      </nav>
      {connectionError && (
        <p role="alert" className="error-message">
          {connectionError}
        </p>
      )}
      <div className="connection-caption">
        {mode === 'demo'
          ? 'サンプルデータ · 接続不要'
          : `MySQL · ${readOnly ? '読み取り専用' : '読み書き可能'}`}
      </div>
      <div className="section-label schemas-label">
        <span>
          <Layers3 size={14} /> SCHEMAS
        </span>
        <span>{snapshot.tables.length}</span>
      </div>
      <nav aria-label="テーブル一覧" className="schema-tree">
        {schemas.map((schema) => (
          <details open key={schema}>
            <summary>
              <ChevronDown size={13} />
              <Folder size={15} />
              {schema}
              <span>{tables.filter((t) => t.schema === schema).length}</span>
            </summary>
            {tables
              .filter((t) => t.schema === schema)
              .map((table) => (
                <button
                  key={table.id}
                  className={`tree-table ${selected === table.id ? 'active' : ''}`}
                  onClick={() => onSelect(table.id)}
                >
                  <Table2 size={15} />
                  <span>{table.name}</span>
                  {selected === table.id && <span className="selected-dot" />}
                </button>
              ))}
          </details>
        ))}
        {!tables.length && (
          <div className="empty-sidebar">
            <Search size={20} />
            <p>一致するテーブルがありません</p>
          </div>
        )}
      </nav>
      <div className="sidebar-bottom">
        <div className="tip-card">
          <Sparkles size={19} />
          <p>
            データのつながりを、
            <br />
            <strong>見えるかたちに。</strong>
          </p>
        </div>
        {mode !== 'demo' && (
          <Button variant="ghost" className="w-full mt-3" disabled={busy} onClick={onDemo}>
            デモに切り替え・切断
          </Button>
        )}
        <div className="sidebar-version">
          RelaGrid <span>v0.1.0</span>
        </div>
      </div>
    </aside>
  );
}
