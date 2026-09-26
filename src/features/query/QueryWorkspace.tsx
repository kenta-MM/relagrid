import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Download, Play, Plus, Save, Table2, X, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { QueryResult, QueryResultSet, Table } from '@/domain/database';
import { SqlEditor } from './SqlEditor';
import { CsvExportDialog, type ExportSelection } from '@/features/csv/CsvExportDialog';
import { claimShortcut, shortcutTarget } from '@/lib/shortcuts';

interface ResultView {
  page: number;
  size: number;
  top: number;
  left: number;
}
const defaultView: ResultView = { page: 0, size: 10, top: 0, left: 0 };
function resultSets(result?: QueryResult): QueryResultSet[] {
  return result ? (result.resultSets ?? [{ ...result, complete: true }]) : [];
}
function rowCount(result?: QueryResult) {
  return resultSets(result).reduce((count, set) => count + set.rows.length, 0);
}
interface QueryTab {
  id: number;
  name: string;
  sql: string;
  result?: QueryResult;
  plan?: QueryResult;
  error?: string;
  lastSql?: string;
  savedSql: string;
  connectionId: number;
  connectionLabel: string;
  readOnly: boolean;
  resultTab: string;
  resultIndex: number;
  views: Record<string, ResultView>;
  executionId?: string;
  cancelling?: boolean;
}
interface Execution {
  id: string;
  tabId: number;
  sql: string;
  time: string;
  result?: QueryResult;
  error?: string;
  explain: boolean;
  connectionId: number;
  connectionLabel: string;
  readOnly: boolean;
}
interface Props {
  active: boolean;
  tables: Table[];
  selected: string;
  readOnly: boolean;
  busy: boolean;
  mode: string;
  connectionId: number;
  connectionLabel: string;
  execute(sql: string, explain?: boolean, executionId?: string): Promise<QueryResult>;
  cancel(executionId: string): Promise<void>;
}
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ResultTable({
  result,
  page,
  size,
}: {
  result: QueryResultSet;
  page: number;
  size: number;
}) {
  return (
    <table className="data-table query-data">
      <thead>
        <tr>
          <th>#</th>
          {result.columns.map((name, i) => (
            <th key={i}>{name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.slice(page * size, (page + 1) * size).map((row, index) => (
          <tr key={index}>
            <td>{page * size + index + 1}</td>
            {row.map((value, i) => (
              <td key={i}>{value === null ? <em>NULL</em> : value}</td>
            ))}
          </tr>
        ))}
      </tbody>
      {!result.rows.length && (
        <caption>
          {result.columns.length
            ? result.truncated
              ? '表示上限により行データを省略しました'
              : !result.complete
                ? '取得済みの行はありません（未完了）'
                : '結果は0件です'
            : `${result.affectedRows} 行に影響しました`}
        </caption>
      )}
    </table>
  );
}
export function QueryWorkspace({
  active,
  tables,
  selected,
  readOnly,
  busy,
  connectionId,
  connectionLabel,
  execute,
  cancel,
}: Props) {
  const nextId = useRef(2);
  const inFlight = useRef(false);
  function initialSql() {
    const table = tables.find((t) => t.id === selected) ?? tables[0];
    return table ? `SELECT * FROM \`${table.name.replaceAll('`', '``')}\` LIMIT 100;` : 'SELECT 1;';
  }
  function createTab(id: number, sql: string): QueryTab {
    return {
      id,
      name: `Query ${id}`,
      sql,
      savedSql: '',
      connectionId,
      connectionLabel,
      readOnly,
      resultTab: 'result',
      resultIndex: 0,
      views: {},
    };
  }
  const [tabs, setTabs] = useState<QueryTab[]>(() => [createTab(1, initialSql())]);
  const [tabId, setTabId] = useState(1);
  const previousConnection = useRef(connectionId);
  useEffect(() => {
    if (previousConnection.current === connectionId) return;
    previousConnection.current = connectionId;
    const existing = tabs.find((tab) => tab.connectionId === connectionId);
    if (existing) setTabId(existing.id);
    else add();
  }, [connectionId]);
  const [inspectorTab, setInspectorTab] = useState('summary');
  const [history, setHistory] = useState<Execution[]>([]);
  const [compare, setCompare] = useState(false);
  const [exportSelection, setExportSelection] = useState<ExportSelection | null>(null);
  const current = tabs.find((tab) => tab.id === tabId)!;
  function selectEditor(id: number) {
    if (id === tabId) {
      document.querySelector<HTMLElement>('.sql-code-editor [contenteditable="true"]')?.focus();
      return;
    }
    setTabId(id);
  }
  function closeEditor(id: number) {
    const tab = tabs.find((tab) => tab.id === id);
    if (!tab || tab.executionId || tabs.length === 1) return;
    if (tab.sql !== tab.savedSql && !window.confirm(`${tab.name}の未保存SQLを破棄しますか？`))
      return;
    setTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    if (tabId === id) selectEditor(tabs.find((tab) => tab.id !== id)!.id);
  }
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = shortcutTarget(event);
      if (!active || !target?.closest('.query-workspace')) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      let action: (() => void) | undefined;
      if (mod && !event.altKey && !event.shiftKey && key === 't') action = () => add();
      else if (mod && !event.altKey && !event.shiftKey && key === 'w')
        action = () => closeEditor(tabId);
      else if (mod && !event.altKey && key === 'tab')
        action = () => {
          const index = tabs.findIndex((tab) => tab.id === tabId);
          selectEditor(tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
        };
      else if (
        (!mod && !event.altKey && key === 'f5') ||
        (mod && !event.altKey && !event.shiftKey && key === 'enter')
      ) {
        action = event.shiftKey ? () => void stop() : () => void run();
      } else if (
        event.altKey &&
        !mod &&
        !event.shiftKey &&
        target.closest('.sql-results') &&
        (key === 'arrowleft' || key === 'arrowright')
      ) {
        action = () => {
          if (resultTab !== 'result' || sets.length < 2) return;
          update(tabId, {
            resultIndex: (resultIndex + (key === 'arrowleft' ? -1 : 1) + sets.length) % sets.length,
          });
        };
      }
      if (action) claimShortcut(event, action);
    }
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  });
  const { resultTab } = current;
  const batch = resultTab === 'plan' ? current.plan : current.result;
  const sets = resultSets(batch);
  const resultIndex = resultTab === 'plan' ? 0 : current.resultIndex;
  const viewKey = `${resultTab}:${resultIndex}`;
  const view = current.views[viewKey] ?? defaultView;
  const { page, size } = view;
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroll.current) {
      scroll.current.scrollTop = view.top;
      scroll.current.scrollLeft = view.left;
    }
  }, [tabId, resultTab, resultIndex, active, batch, page, size]);
  function updateView(changes: Partial<ResultView>) {
    setTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              views: {
                ...tab.views,
                [viewKey]: { ...(tab.views[viewKey] ?? defaultView), ...changes },
              },
            }
          : tab,
      ),
    );
  }
  function setSize(size: number) {
    updateView({ size, page: 0, top: 0, left: 0 });
  }
  const canRun =
    !busy && !inFlight.current && current.connectionId === connectionId && !!current.sql.trim();
  function setResultTab(resultTab: string) {
    update(tabId, { resultTab });
  }
  function setPage(page: number) {
    updateView({ page, top: 0, left: 0 });
  }
  const result = resultTab === 'messages' ? undefined : sets[resultIndex];
  const latest = current.executionId
    ? undefined
    : history.find(
        (item) =>
          item.tabId === tabId &&
          (resultTab === 'messages' || item.explain === (resultTab === 'plan')),
      );
  const pageCount = Math.max(1, Math.ceil((result?.rows.length ?? 0) / size));
  function update(id: number, changes: Partial<QueryTab>) {
    setTabs((tabs) => tabs.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab)));
  }
  function add(
    sql = initialSql(),
    owner?: Pick<QueryTab, 'connectionId' | 'connectionLabel' | 'readOnly'>,
  ) {
    const id = nextId.current++;
    const tab = createTab(id, sql);
    if (owner) {
      tab.connectionId = owner.connectionId;
      tab.connectionLabel = owner.connectionLabel;
      tab.readOnly = owner.readOnly;
    }
    setTabs((tabs) => [...tabs, tab]);
    selectEditor(id);
  }
  async function run(explain = false) {
    if (!canRun || inFlight.current) return;
    inFlight.current = true;
    const id = current.id,
      sql = current.sql;
    const executionId = crypto.randomUUID();
    update(id, {
      executionId,
      cancelling: false,
      resultTab: explain ? 'plan' : 'result',
      resultIndex: explain ? current.resultIndex : 0,
      views: Object.fromEntries(
        Object.entries(current.views).filter(
          ([key]) => !key.startsWith(explain ? 'plan:' : 'result:'),
        ),
      ),
      error: undefined,
      ...(explain ? { plan: undefined } : { result: undefined }),
    });
    try {
      const result = await execute(sql, explain, executionId);
      update(id, {
        [explain ? 'plan' : 'result']: result,
        lastSql: sql,
        error: result.error ?? undefined,
      });
      setHistory((items) =>
        [
          {
            id: executionId,
            tabId: id,
            sql,
            time: new Date().toLocaleTimeString('ja-JP'),
            result,
            error: result.error ?? undefined,
            explain,
            connectionId: current.connectionId,
            connectionLabel: current.connectionLabel,
            readOnly: current.readOnly,
          },
          ...items,
        ].slice(0, 50),
      );
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      update(id, { error: message, resultTab: 'messages' });
      setHistory((items) =>
        [
          {
            id: executionId,
            tabId: id,
            sql,
            time: new Date().toLocaleTimeString('ja-JP'),
            error: message,
            explain,
            connectionId: current.connectionId,
            connectionLabel: current.connectionLabel,
            readOnly: current.readOnly,
          },
          ...items,
        ].slice(0, 50),
      );
    } finally {
      inFlight.current = false;
      update(id, { executionId: undefined, cancelling: false });
    }
  }
  async function stop() {
    const { id, executionId } = current;
    if (!executionId || current.cancelling) return;
    update(id, { cancelling: true });
    try {
      await cancel(executionId);
    } catch (error) {
      setTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === id && tab.executionId === executionId
            ? { ...tab, cancelling: false, error: String(error), resultTab: 'messages' }
            : tab,
        ),
      );
    }
  }
  function exportCsv() {
    if (!result) return;
    setExportSelection({
      result,
      name: `${current.name}${sets.length > 1 ? `-result-${resultIndex + 1}` : ''}.csv`,
      label: `${current.name} / ${resultTab === 'plan' ? '実行計画' : `結果 ${resultIndex + 1}`}`,
    });
  }
  if (!active) return null;
  return (
    <div className="query-workspace" style={{ display: 'contents' }}>
      <main className="main-panel sql-main">
        <section className="sql-editor-panel" aria-label="SQLエディタ">
          <div className="sql-toolbar">
            <div
              className="query-tabs"
              role="tablist"
              aria-label="クエリ"
              title="Ctrl+Tab: 次のエディタ / Ctrl+Shift+Tab: 前のエディタ"
              aria-keyshortcuts="Control+Tab Control+Shift+Tab"
            >
              {tabs.map((tab) => (
                <div className={`query-tab ${tab.id === tabId ? 'active' : ''}`} key={tab.id}>
                  <button
                    role="tab"
                    aria-label={tab.name}
                    title={`${tab.connectionLabel}${tab.sql !== tab.savedSql ? ' · 未保存' : ''}`}
                    aria-selected={tab.id === tabId}
                    onClick={() => {
                      selectEditor(tab.id);
                    }}
                  >
                    <Table2 size={14} />
                    {tab.name}
                    {tab.sql !== tab.savedSql && <span aria-hidden="true"> *</span>}
                    {tab.executionId && <span>（実行中）</span>}
                  </button>
                  {tabs.length > 1 && (
                    <button
                      aria-label={`${tab.name}を閉じる`}
                      title="閉じる（Ctrl+W）"
                      aria-keyshortcuts="Control+w"
                      disabled={!!tab.executionId}
                      onClick={() => closeEditor(tab.id)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))}
              <Button
                variant="ghost"
                size="icon"
                aria-label="新規クエリ"
                title="新規クエリ（Ctrl+T）"
                aria-keyshortcuts="Control+t"
                onClick={() => add()}
              >
                <Plus size={18} />
              </Button>
            </div>
            <div className="query-actions">
              <Button variant="outline" size="sm" onClick={() => add(current.sql, current)}>
                <Copy size={14} />
                複製
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!current.lastSql}
                aria-pressed={compare}
                onClick={() => setCompare(!compare)}
              >
                比較
              </Button>
              <Button
                size="sm"
                disabled={!canRun}
                title="SQL全文を実行（F5 / Ctrl+Enter）。選択範囲があっても全文を実行します。"
                aria-keyshortcuts="F5 Control+Enter"
                onClick={() => void run()}
              >
                <Play size={14} />
                {current.executionId ? '実行中…' : '実行'}
              </Button>
              {current.executionId && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={current.cancelling}
                  title="このエディタの実行を中断（Shift+F5）"
                  aria-keyshortcuts="Shift+F5"
                  onClick={() => void stop()}
                >
                  {current.cancelling ? '中断待ち…' : '中断'}
                </Button>
              )}
            </div>
          </div>
          <div className="editor-meta">
            <span>
              {current.connectionLabel} ·{' '}
              {current.connectionId === 0 ? 'DEMO · サンプルSELECTのみ' : 'MySQL'} ·{' '}
              {current.readOnly ? '読み取り専用' : '読み書き可能'}
              {current.connectionId !== connectionId &&
                ' · 実行するにはサイドバーでこの接続を選択してください'}
              {busy && !current.executionId && ' · 他の操作が完了するまで実行できません'}
            </span>
            <span title="Ctrl+T: 新規 / Ctrl+W: 終了 / Ctrl+Tab・Ctrl+Shift+Tab: エディタ移動 / F5・Ctrl+Enter: 全文実行 / Shift+F5: 中断 / Ctrl+1: リレーション / Ctrl+2: SQL / 結果内でAlt+←・→: 結果切り替え">
              Tab で補完 · F5 / Ctrl+Enter で全文実行（選択範囲に関係なく）
            </span>
          </div>
          <SqlEditor
            key={tabId}
            value={current.sql}
            tables={current.connectionId === connectionId ? tables : []}
            onChange={(sql) => update(tabId, { sql })}
          />
          {compare && current.lastSql && (
            <div className="query-comparison">
              <span>前回実行したSQL</span>
              <pre>{current.lastSql}</pre>
            </div>
          )}
        </section>
        <section
          className="sql-results"
          aria-label="クエリ実行結果"
          tabIndex={0}
          title="結果内でAlt+← / Alt+→: 前 / 次の結果"
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        >
          <div className="result-toolbar">
            <div role="tablist" aria-label="実行結果の表示">
              {[
                ['result', '結果'],
                ['plan', '実行計画'],
                ['messages', 'メッセージ'],
              ].map(([id, title]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={resultTab === id}
                  className={resultTab === id ? 'active' : ''}
                  onClick={() => {
                    setResultTab(id);
                  }}
                >
                  {title}
                </button>
              ))}
            </div>
            {resultTab === 'plan' && current.plan && (
              <Button variant="ghost" size="sm" disabled={!canRun} onClick={() => void run(true)}>
                再取得
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!result?.columns.length}
              onClick={exportCsv}
            >
              <Download size={14} />
              エクスポート
            </Button>
          </div>
          {resultTab === 'result' && sets.length > 1 && (
            <div className="result-set-tabs" role="tablist" aria-label="Result Set">
              {sets.map((set, index) => (
                <button
                  key={index}
                  role="tab"
                  aria-selected={resultIndex === index}
                  onClick={() => update(tabId, { resultIndex: index })}
                >
                  {set.columns.length ? '結果' : '更新'} {index + 1}
                  {!set.complete ? '（未完了）' : set.truncated ? '（省略あり）' : ''}
                </button>
              ))}
            </div>
          )}
          {(current.error || batch?.error) && resultTab !== 'messages' && (
            <div className="query-message" role="alert">
              実行全体は失敗しました。{batch?.error || current.error}
            </div>
          )}
          <div
            className="query-result-scroll"
            ref={scroll}
            onScroll={(event) =>
              updateView({
                top: event.currentTarget.scrollTop,
                left: event.currentTarget.scrollLeft,
              })
            }
          >
            {resultTab === 'messages' ? (
              <div className="query-message" role={current.error ? 'alert' : 'status'}>
                {current.error ||
                  (latest?.result
                    ? `${latest.explain ? '実行計画を取得' : '実行完了'} · ${latest.result.elapsedMs} ms · ${rowCount(latest.result)} 行取得 · ${latest.result.affectedRows} 行に影響`
                    : current.executionId
                      ? '実行中です。'
                      : 'SQLを入力して実行してください。')}
                {latest?.result?.truncated && (
                  <p>
                    結果は上限（結果ごとに1,000行・各値5,000文字・実行全体で約5MB）で省略されています。
                  </p>
                )}
              </div>
            ) : result ? (
              <ResultTable result={result} page={page} size={size} />
            ) : (
              <div className="preview-empty">
                {resultTab === 'plan' ? (
                  <Button variant="outline" disabled={!canRun} onClick={() => void run(true)}>
                    実行計画を取得（EXPLAIN）
                  </Button>
                ) : (
                  'SQLを実行すると、ここに結果が表示されます。'
                )}
              </div>
            )}
          </div>
          <div className="query-pagination">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              前へ
            </Button>
            <span>
              {page + 1} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              次へ
            </Button>
            <span className="result-count">
              {result
                ? `${result.rows.length} 行 · 実行全体 ${batch?.elapsedMs} ms${result.truncated ? '（上限で省略）' : ''}${!result.complete ? '（取得未完了）' : ''}`
                : '未実行'}
            </span>
            <select
              aria-label="1ページの行数"
              value={size}
              onChange={(event) => {
                setSize(Number(event.target.value));
                setPage(0);
              }}
            >
              {[10, 25, 100].map((n) => (
                <option key={n} value={n}>
                  {n} 行/ページ
                </option>
              ))}
            </select>
          </div>
        </section>
      </main>
      <aside className="details-panel query-inspector" aria-keyshortcuts="Control+Alt+b Meta+Alt+b">
        <div className="details-title">
          <h2>クエリ詳細</h2>
          <span className="tiny-label">INSPECTOR</span>
        </div>
        <div className="selected-table">
          <div className="detail-icon">
            <Table2 size={24} />
          </div>
          <div>
            <h3>Query Inspector</h3>
            <p>実行したクエリの情報を表示</p>
          </div>
        </div>
        <div className="inspector-tabs" role="tablist" aria-label="クエリ詳細の表示">
          {[
            ['summary', '概要'],
            ['history', '履歴'],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={inspectorTab === id}
              className={inspectorTab === id ? 'active' : ''}
              onClick={() => setInspectorTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {inspectorTab === 'summary' && (
          <dl className="query-metrics">
            <div>
              <dt>参照テーブル / CTE</dt>
              <dd>
                {latest?.result?.referencedTables.length
                  ? latest.result.referencedTables.map((name) => <div key={name}>{name}</div>)
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>実行時間</dt>
              <dd>{latest?.result ? `${latest.result.elapsedMs} ms` : '—'}</dd>
            </div>
            <div>
              <dt>返却行数</dt>
              <dd>{latest?.result ? `${rowCount(latest.result)} 行` : '—'}</dd>
            </div>
            <div>
              <dt>影響行数</dt>
              <dd>{latest?.result?.affectedRows ?? '—'}</dd>
            </div>
            <div>
              <dt>接続モード</dt>
              <dd>
                {current.connectionLabel} · {current.readOnly ? '読み取り専用' : '読み書き可能'}
              </dd>
            </div>
            <div>
              <dt>状態</dt>
              <dd>
                {current.executionId
                  ? '実行中'
                  : latest?.error
                    ? '実行エラー'
                    : latest
                      ? '成功'
                      : '未実行'}
              </dd>
            </div>
          </dl>
        )}
        <div className="history-heading">
          <Clock size={15} />
          {inspectorTab === 'history' ? '実行履歴（直近50件）' : '最近の実行'}
        </div>
        <div className="query-history">
          {(inspectorTab === 'history' ? history : history.slice(0, 3)).map((item) => (
            <button
              key={item.id}
              title={`${item.connectionLabel}: ${item.sql}`}
              onClick={() => add(item.sql, item)}
            >
              <span className={item.error ? 'execution-error' : 'execution-success'}>●</span>
              <span>{item.error ? 'エラー' : `${item.result!.elapsedMs} ms`}</span>
              <span>{item.explain ? 'EXPLAIN' : `${rowCount(item.result)} 行`}</span>
              <time>{item.time}</time>
            </button>
          ))}
          {!history.length && <p className="muted">実行履歴はありません。</p>}
        </div>
        <div className="query-inspector-actions">
          <Button
            onClick={() => {
              download(`${current.name}.sql`, current.sql, 'text/plain;charset=utf-8');
              update(tabId, { savedSql: current.sql });
            }}
          >
            <Save size={16} />
            保存する
          </Button>
          <Button variant="outline" onClick={() => add()}>
            <Plus size={16} />
            新規クエリ
          </Button>
        </div>
      </aside>
      {exportSelection && (
        <CsvExportDialog selection={exportSelection} close={() => setExportSelection(null)} />
      )}
    </div>
  );
}
