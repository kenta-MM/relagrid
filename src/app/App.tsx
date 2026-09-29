import {
  useShortcuts,
  matchesShortcut,
  shortcutLabel,
  shortcutAria,
} from '@/lib/shortcut-settings';
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
  const shortcuts = useShortcuts();
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        !shortcutTarget(event) ||
        !matchesShortcut(event, shortcuts.search) ||
        event.repeat ||
        target?.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      event.preventDefault();
      setSidebarOpen(true);
      requestAnimationFrame(() => searchInput.current?.focus());
    }
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [shortcuts]);
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
      if (!shortcutTarget(event)) return;
      const open = matchesShortcut(event, shortcuts.sidebarOpen);
      const close = matchesShortcut(event, shortcuts.sidebarClose);
      const inspector = matchesShortcut(event, shortcuts.inspector);
      if (!open && !close && !inspector) return;
      claimShortcut(event, () => {
        if (document.activeElement?.closest(inspector ? '.details-panel' : '.sidebar')) {
          document
            .querySelector<HTMLElement>(
              screen === 'sql'
                ? '.sql-code-editor [contenteditable="true"]'
                : '.view-switch button[aria-pressed="true"]',
            )
            ?.focus();
        }
        if (inspector) setInspectorOpen((open) => !open);
        else setSidebarOpen((previous) => (open && close ? !previous : open));
      });
    }
    window.addEventListener('keydown', togglePanel, true);
    return () => window.removeEventListener('keydown', togglePanel, true);
  }, [screen, shortcuts]);
  const modeFocus = useRef(false);
  useEffect(() => {
    function switchMode(event: KeyboardEvent) {
      if (!shortcutTarget(event)) return;
      const relations = matchesShortcut(event, shortcuts.relations);
      const sql = matchesShortcut(event, shortcuts.sql);
      if (!relations && !sql && !matchesShortcut(event, shortcuts.switchMode)) return;
      claimShortcut(event, () => {
        const nextScreen = relations
          ? 'relations'
          : sql
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
  }, [screen, shortcuts]);
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
      title={`${shortcutLabel(shortcuts.relations)}: リレーション / ${shortcutLabel(shortcuts.sql)}: SQL`}
      aria-keyshortcuts={shortcutAria(shortcuts.switchMode)}
    >
      <button
        aria-pressed={screen === 'relations'}
        aria-keyshortcuts={shortcutAria(shortcuts.relations)}
        title={`リレーション（${shortcutLabel(shortcuts.relations)}）`}
        onClick={() => setScreen('relations')}
      >
        <GitBranch size={14} />
        リレーション
      </button>
      <button
        aria-pressed={screen === 'sql'}
        aria-keyshortcuts={shortcutAria(shortcuts.sql)}
        title={`SQL（${shortcutLabel(shortcuts.sql)}）`}
        onClick={() => setScreen('sql')}
      >
        <Database size={14} />
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
          connections={explorer.connections}
          connectionGroups={explorer.connectionGroups}
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
          onDisconnect={() => void explorer.disconnect()}
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
            busy={explorer.busy}
            sessionId={explorer.snapshot.sessionId}
            connectionLabel={`${connection?.host}:${connection?.port} / ${explorer.database}`}
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
            explorer.mode === 'disconnected'
              ? '未接続'
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
          {explorer.mode === 'disconnected'
            ? '未接続 — 接続を追加または選択してください'
            : `MySQL · ${explorer.database}`}
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
