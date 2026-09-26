import { useRef, useState, type RefObject, type DragEvent } from 'react';
import {
  ChevronDown,
  Database,
  Folder,
  FolderPlus,
  Table2,
  Layers3,
  Plus,
  Search,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GroupDialog } from '@/features/connection/GroupDialog';
import type { ConnectionEntry, SchemaSnapshot } from '@/domain/database';
import { DEMO_CONNECTION_ID } from '@/domain/database';
interface Props {
  hidden?: boolean;
  snapshot: SchemaSnapshot;
  selected: string;
  query: string;
  onQueryChange(query: string): void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onRefresh(): void;
  database: string;
  connections: ConnectionEntry[];
  connectionGroups: string[];
  demoGroup?: string;
  onAddGroup(name: string): void;
  onMoveConnection(id: number, group?: string): void;
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
  hidden,
  snapshot,
  selected,
  query,
  onQueryChange,
  searchInputRef,
  onRefresh,
  database,
  connections,
  connectionGroups,
  demoGroup,
  onAddGroup,
  onMoveConnection,
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
  const [groupOpen, setGroupOpen] = useState(false);
  const draggedId = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  function endDrag() {
    draggedId.current = null;
    setDragging(false);
    setDropTarget(null);
  }
  function dropHandlers(group = '') {
    return {
      onDragOver(event: DragEvent<HTMLElement>) {
        if (busy || draggedId.current === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(group);
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropTarget((current) => (current === group ? null : current));
        }
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (busy || draggedId.current === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (
          event.dataTransfer.getData('application/x-relagrid-connection') ===
          String(draggedId.current)
        ) {
          onMoveConnection(draggedId.current, group || undefined);
          if (event.currentTarget instanceof HTMLDetailsElement) event.currentTarget.open = true;
        }
        endDrag();
      },
    };
  }
  const tables = snapshot.tables.filter((table) =>
    `${table.name} ${table.schema} ${table.columns.map((c) => c.name).join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const schemas = [...new Set(tables.map((table) => table.schema))];
  const groups = new Map<string, ConnectionEntry[]>(connectionGroups.map((group) => [group, []]));
  const visibleConnections: ConnectionEntry[] =
    mode === 'demo'
      ? [{ id: DEMO_CONNECTION_ID, database, group: demoGroup, host: '', port: 0 }, ...connections]
      : connections;
  for (const connection of visibleConnections) {
    if (!connection.group) continue;
    const entries = groups.get(connection.group) ?? [];
    entries.push(connection);
    groups.set(connection.group, entries);
  }
  function connectionItem(connection: ConnectionEntry) {
    const demo = connection.id === DEMO_CONNECTION_ID;
    const active = demo ? mode === 'demo' : connection.id === activeConnectionId;
    return (
      <button
        key={connection.id}
        className={`connection-item ${active ? 'active' : ''}`}
        draggable={!busy}
        onDragStart={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          draggedId.current = connection.id;
          event.dataTransfer.setData('application/x-relagrid-connection', String(connection.id));
          event.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={endDrag}
        onClick={() => onSelectConnection(connection.id)}
        disabled={busy}
        aria-pressed={active}
        title={
          demo
            ? 'サンプルデータ · 接続不要'
            : `${connection.database} · ${connection.host}:${connection.port}`
        }
      >
        <Database size={17} />
        <strong>{connection.database}</strong>
        {active && <span className={`status-dot ${demo ? 'demo' : ''}`} />}
      </button>
    );
  }
  return (
    <aside className="sidebar" hidden={hidden} aria-keyshortcuts="Control+b Meta+b">
      <div className="sidebar-search">
        <Search size={15} />
        <input
          ref={searchInputRef}
          aria-keyshortcuts="/"
          aria-label="テーブル・カラムを検索"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="テーブル・カラムを検索…"
          title="テーブル名・カラム名で検索（/）"
        />
        {query && (
          <button aria-label="検索をクリア" onClick={() => onQueryChange('')}>
            ×
          </button>
        )}
        <span>/</span>
      </div>
      <div className="section-label">
        <span>
          <Database size={14} /> CONNECTIONS
        </span>
        <div className="connection-actions">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setGroupOpen(true)}
            aria-label="グループを追加"
            title="グループを追加"
          >
            <FolderPlus size={16} />
          </Button>
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
      </div>
      <nav className="connection-tree" aria-label="接続一覧" {...dropHandlers()}>
        {[...groups].map(([group, entries], index) => (
          <details
            className={`connection-group ${dropTarget === group ? 'drop-target' : ''}`}
            open
            key={group}
            {...dropHandlers(group)}
          >
            <summary title={group}>
              <ChevronDown size={13} />
              <span className={`group-dot group-color-${index % 6}`} />
              <span className="group-name">{group}</span>
              <span className="group-count">{entries.length}</span>
            </summary>
            <div className="connection-group-items">{entries.map(connectionItem)}</div>
          </details>
        ))}
        {visibleConnections.filter((connection) => !connection.group).map(connectionItem)}
      </nav>
      {dragging && (
        <div
          className={`connection-ungroup-drop ${dropTarget === '' ? 'drop-target' : ''}`}
          {...dropHandlers()}
        >
          グループ外へ移動
          <span>ここにドロップ</span>
        </div>
      )}
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
        <div className="connection-actions">
          <span>{snapshot.tables.length}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={busy}
            aria-label="更新"
            title="スキーマを更新"
          >
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          </Button>
        </div>
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
        {mode !== 'demo' && (
          <Button variant="ghost" className="w-full mt-3" disabled={busy} onClick={onDemo}>
            デモに切り替え・切断
          </Button>
        )}
        <div className="sidebar-version">
          RelaGrid <span>v0.1.0</span>
        </div>
      </div>
      <GroupDialog
        open={groupOpen}
        onOpenChange={setGroupOpen}
        groups={connectionGroups}
        onAdd={onAddGroup}
      />
    </aside>
  );
}
