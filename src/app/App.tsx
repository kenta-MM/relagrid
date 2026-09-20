import { useEffect, useRef, useState } from 'react';
import { Boxes, Search, Plug, RefreshCw, GitBranch, ShieldCheck, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConnectionDialog } from '@/features/connection/ConnectionDialog';
import { SchemaGraph } from '@/features/graph/SchemaGraph';
import { Sidebar } from '@/features/explorer/Sidebar';
import { TableDetails } from '@/features/explorer/TableDetails';
import { BottomPanel } from '@/features/explorer/BottomPanel';
import { useExplorer } from '@/features/explorer/useExplorer';
export function App() {
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== '/' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')
      )
        return;
      event.preventDefault();
      searchInput.current?.focus();
    }
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  const explorer = useExplorer();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [relatedOnly, setRelatedOnly] = useState(false);
  const [tab, setTab] = useState('activity');
  const table = explorer.snapshot.tables.find((t) => t.id === explorer.selected);
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-icon">
            <Boxes size={27} />
          </span>
          <div>
            <h1>RelaGrid</h1>
            <p>データのつながりを、見える化する</p>
          </div>
        </div>
        <div className="global-search">
          <Search size={17} />
          <input
            ref={searchInput}
            aria-keyshortcuts="/"
            aria-label="テーブル・カラムを検索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="テーブル名・カラム名で検索…"
          />
          {query && (
            <button aria-label="検索をクリア" onClick={() => setQuery('')}>
              ×
            </button>
          )}
          <span>/</span>
        </div>
        <div className="header-actions">
          <span className="environment-badge">{explorer.mode === 'demo' ? 'DEMO' : 'MYSQL'}</span>
          <Button
            variant="outline"
            onClick={() => setConnectionOpen(true)}
            disabled={explorer.busy}
          >
            <Plug size={16} />
            接続
          </Button>
          <Button onClick={() => void explorer.refresh()} disabled={explorer.busy}>
            <RefreshCw size={15} className={explorer.busy ? 'animate-spin' : ''} />
            更新
          </Button>
          <span className="connection-status">
            <span className={`status-dot ${explorer.mode === 'demo' ? 'demo' : ''}`} />
            {explorer.mode === 'demo' ? 'デモモード' : explorer.database}
          </span>
        </div>
      </header>
      <div className="workspace">
        <Sidebar
          snapshot={explorer.snapshot}
          selected={explorer.selected}
          query={query}
          database={explorer.database}
          mode={explorer.mode}
          busy={explorer.busy}
          onSelect={explorer.select}
          onConnect={() => setConnectionOpen(true)}
          onDemo={() => void explorer.useDemo()}
        />
        <main className="main-panel">
          <div className="map-heading">
            <div>
              <div className="eyebrow">
                <GitBranch size={13} /> DATABASE EXPLORER
              </div>
              <h2>リレーションシップマップ</h2>
              <p>テーブル間の関係と依存関係を視覚的に探索</p>
            </div>
            <div className="map-stats">
              <span>
                <strong>{explorer.snapshot.tables.length}</strong> tables
              </span>
              <i />
              <span>
                <strong>{explorer.snapshot.relationships.length}</strong> relations
              </span>
            </div>
          </div>
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
            mode={explorer.mode}
            onClear={explorer.clearLogs}
          />
        </main>
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
      <footer className="status-bar">
        <span>
          <Database size={12} />
          {explorer.mode === 'demo' ? 'サンプルデータを表示中' : `MySQL · ${explorer.database}`}
        </span>
        <span>
          <ShieldCheck size={12} />
          READ ONLY<span className="footer-divider">|</span>RelaGrid 0.1.0
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
