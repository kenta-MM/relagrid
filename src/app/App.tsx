import { useEffect, useRef, useState } from 'react';
import { GitBranch, ShieldCheck, Database } from 'lucide-react';
import { WindowHeader } from './WindowHeader';
import { ConnectionDialog } from '@/features/connection/ConnectionDialog';
import { SchemaGraph } from '@/features/graph/SchemaGraph';
import { Sidebar } from '@/features/explorer/Sidebar';
import { TableDetails } from '@/features/explorer/TableDetails';
import { BottomPanel } from '@/features/explorer/BottomPanel';
import { useExplorer } from '@/features/explorer/useExplorer';
import { QueryWorkspace } from '@/features/query/QueryWorkspace';
import { claimShortcut, shortcutTarget } from '@/lib/shortcuts';
export function App() {
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== '/' ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')
      )
        return;
      event.preventDefault();
      setSidebarOpen(true);
      requestAnimationFrame(() => searchInput.current?.focus());
    }
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  const explorer = useExplorer();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [relatedOnly, setRelatedOnly] = useState(false);
  const [tab, setTab] = useState('activity');
  const [screen, setScreen] = useState<'relations' | 'sql'>('relations');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  useEffect(() => {
    function togglePanel(event: KeyboardEvent) {
      if (
        !shortcutTarget(event) ||
        !(event.ctrlKey || event.metaKey) ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'b'
      )
        return;
      claimShortcut(event, () => {
        if (document.activeElement?.closest(event.altKey ? '.details-panel' : '.sidebar')) {
          document
            .querySelector<HTMLElement>(
              screen === 'sql'
                ? '.sql-code-editor [contenteditable="true"]'
                : '.view-switch button[aria-pressed="true"]',
            )
            ?.focus();
        }
        if (event.altKey) setInspectorOpen((open) => !open);
        else setSidebarOpen((open) => !open);
      });
    }
    window.addEventListener('keydown', togglePanel, true);
    return () => window.removeEventListener('keydown', togglePanel, true);
  }, [screen]);
  const modeFocus = useRef(false);
  useEffect(() => {
    function switchMode(event: KeyboardEvent) {
      if (
        !shortcutTarget(event) ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        !(
          (!event.shiftKey && (event.key === '1' || event.key === '2')) ||
          (event.shiftKey && event.key.toLowerCase() === 'm')
        )
      )
        return;
      claimShortcut(event, () => {
        const nextScreen =
          event.key === '1'
            ? 'relations'
            : event.key === '2'
              ? 'sql'
              : screen === 'sql'
                ? 'relations'
                : 'sql';
        modeFocus.current = nextScreen !== screen;
        setScreen(nextScreen);
      });
    }
    window.addEventListener('keydown', switchMode, true);
    return () => window.removeEventListener('keydown', switchMode, true);
  }, [screen]);
  useEffect(() => {
    if (!modeFocus.current) return;
    modeFocus.current = false;
    document
      .querySelector<HTMLElement>(
        screen === 'sql'
          ? '.sql-code-editor [contenteditable="true"]'
          : '.view-switch button[aria-pressed="true"]',
      )
      ?.focus();
  }, [screen]);
  const navigation = (
    <nav
      className="view-switch"
      aria-label="画面切り替え"
      title="Ctrl+1: リレーション / Ctrl+2: SQL"
      aria-keyshortcuts="Control+Shift+m"
    >
      <button
        aria-pressed={screen === 'relations'}
        aria-keyshortcuts="Control+1"
        title="リレーション（Ctrl+1）"
        onClick={() => setScreen('relations')}
      >
        <GitBranch size={17} />
        リレーション
      </button>
      <button
        aria-pressed={screen === 'sql'}
        aria-keyshortcuts="Control+2"
        title="SQL（Ctrl+2）"
        onClick={() => setScreen('sql')}
      >
        <Database size={17} />
        SQL
      </button>
    </nav>
  );
  const table = explorer.snapshot.tables.find((t) => t.id === explorer.selected);
  const connection = explorer.connections.find((entry) => entry.id === explorer.activeConnectionId);
  return (
    <div className="app-shell">
      <WindowHeader>{navigation}</WindowHeader>
      <div
        className={`workspace${sidebarOpen ? '' : ' sidebar-collapsed'}${inspectorOpen ? '' : ' inspector-collapsed'}`}
      >
        <Sidebar
          hidden={!sidebarOpen}
          snapshot={explorer.snapshot}
          selected={explorer.selected}
          query={query}
          onQueryChange={setQuery}
          searchInputRef={searchInput}
          onRefresh={() => void explorer.refresh()}
          database={explorer.database}
          connections={explorer.connections}
          connectionGroups={explorer.connectionGroups}
          demoGroup={explorer.demoGroup}
          onAddGroup={explorer.addConnectionGroup}
          onMoveConnection={explorer.moveConnection}
          activeConnectionId={explorer.activeConnectionId}
          connectionError={explorer.connectionError}
          onSelectConnection={(id) => void explorer.selectConnection(id)}
          mode={explorer.mode}
          busy={explorer.busy}
          readOnly={explorer.readOnly}
          onSelect={explorer.select}
          onConnect={() => setConnectionOpen(true)}
          onDemo={() => void explorer.useDemo()}
        />
        <main
          className="main-panel"
          style={{ display: screen === 'relations' ? undefined : 'none' }}
        >
          <div className="graph-area">
            <SchemaGraph
              snapshot={explorer.snapshot}
              selected={explorer.selected}
              relatedOnly={relatedOnly}
              onSelect={explorer.select}
            />
            <div className="graph-legend">
              <span className="legend-line" />
              外部キー <span>参照元 → 参照先</span>
            </div>
          </div>
          <BottomPanel
            tab={tab}
            onTab={setTab}
            logs={explorer.logs}
            preview={explorer.preview}
            previewBusy={explorer.previewBusy}
            error={explorer.previewError}
            tableName={table?.name}
            table={table}
            mode={explorer.mode}
            onClear={explorer.clearLogs}
          />
        </main>
        <div
          className="relation-details"
          style={{ display: screen === 'relations' ? 'contents' : 'none' }}
        >
          <TableDetails
            table={table}
            snapshot={explorer.snapshot}
            relatedOnly={relatedOnly}
            busy={explorer.busy || explorer.previewBusy}
            onSelect={explorer.select}
            onBrowse={() => {
              setTab('preview');
              void explorer.browse();
            }}
            onToggleRelated={() => setRelatedOnly((value) => !value)}
          />
        </div>
        <QueryWorkspace
          connectionId={explorer.activeConnectionId ?? 0}
          connectionLabel={
            explorer.mode === 'demo'
              ? 'デモ'
              : `${explorer.database} (${connection?.host}:${connection?.port})`
          }
          active={screen === 'sql'}
          tables={explorer.snapshot.tables}
          selected={explorer.selected}
          readOnly={explorer.readOnly}
          busy={explorer.busy}
          mode={explorer.mode}
          execute={explorer.execute}
          cancel={explorer.cancel}
        />
      </div>
      <footer className="status-bar">
        <span>
          <Database size={12} />
          {explorer.mode === 'demo' ? 'サンプルデータを表示中' : `MySQL · ${explorer.database}`}
        </span>
        <span>
          <ShieldCheck size={12} />
          {explorer.readOnly ? 'READ ONLY' : 'READ / WRITE'}
          <span className="footer-divider">|</span>RelaGrid 0.1.0
        </span>
      </footer>
      <ConnectionDialog
        open={connectionOpen}
        onOpenChange={setConnectionOpen}
        onConnect={explorer.connect}
      />
    </div>
  );
}
