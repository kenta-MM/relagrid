import {
  useShortcuts,
  matchesShortcut,
  shortcutLabel,
  shortcutAria,
} from '@/lib/shortcut-settings';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Save, Download, Play, Plus, Table2, X, Clock, CircleCheck } from 'lucide-react';
import { queryStore, type SavedQuery } from '@/data/query-store';
import { Button } from '@/components/ui/button';
import type { QueryResult, QueryResultSet, Table } from '@/domain/database';
import { SqlEditor } from './SqlEditor';
import { CloseQueryDialog } from './CloseQueryDialog';
import { WriteQueryDialog } from './WriteQueryDialog';
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
  savedSql: string;
  connectionId: number;
  connectionLabel: string;
  readOnly: boolean;
  databaseKind?: 'mysql' | 'sqlServer';
  resultTab: string;
  resultIndex: number;
  views: Record<string, ResultView>;
  executionId?: string;
  cancelling?: boolean;
}
interface Execution {
  databaseKind?: 'mysql' | 'sqlServer';
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
  connectionTarget?: string;
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
  mode,
  active,
  tables,
  selected,
  readOnly,
  busy,
  connectionId,
  connectionLabel,
  connectionTarget,
  execute,
  cancel,
}: Props) {
  const shortcuts = useShortcuts();
  const nextId = useRef(2);
  const inFlight = useRef(false);
  const [writeConfirmation, setWriteConfirmation] = useState<{
    id: number;
    sql: string;
    connectionId: number;
    target: string;
  } | null>(null);
  function initialSql() {
    const table = tables.find((t) => t.id === selected) ?? tables[0];
    if (table && mode === 'sqlServer')
      return `SELECT TOP (100) * FROM [${table.schema.replaceAll(']', ']]')}].[${table.name.replaceAll(']', ']]')}];`;
    return table
      ? `SELECT * FROM \`${table.name.replaceAll('`', '``')}\` LIMIT 100;`
      : connectionId === 0
        ? ''
        : 'SELECT 1;';
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
      databaseKind: mode === 'sqlServer' ? 'sqlServer' : 'mysql',
      resultTab: 'result',
      resultIndex: 0,
      views: {},
    };
  }
  const [tabs, setTabs] = useState<QueryTab[]>(() => [createTab(1, initialSql())]);
  const [tabId, setTabId] = useState(1);
  const savedQueries = useRef<SavedQuery[]>([]);
  const saving = useRef(false);
  const [storeReady, setStoreReady] = useState(false);
  const [storeLoaded, setStoreLoaded] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [storageMessage, setStorageMessage] = useState('');
  const [storageError, setStorageError] = useState('');
  useEffect(() => {
    if (!storageMessage) return;
    const timeout = window.setTimeout(() => setStorageMessage(''), 4000);
    return () => window.clearTimeout(timeout);
  }, [storageMessage]);
  useEffect(() => {
    let cancelled = false;
    void queryStore
      .load()
      .then((saved) => {
        if (cancelled) return;
        savedQueries.current = saved;
        if (saved.length) {
          nextId.current = Math.max(...saved.map((tab) => tab.id)) + 1;
          setTabs(
            saved.map((tab) => ({
              ...createTab(tab.id, tab.sql),
              ...tab,
              savedSql: tab.sql,
            })),
          );
          setTabId(saved[0].id);
        }
        setStoreReady(true);
        setStoreLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setStorageError(`クエリを復元できませんでした: ${String(error)}`);
          setStoreLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function save(all = false) {
    if (!storeReady || saving.current) return;
    const selected = all ? tabs : tabs.filter((tab) => tab.id === tabId);
    const snapshots: SavedQuery[] = selected.map(
      ({ id, name, sql, connectionId, connectionLabel, readOnly, databaseKind }) => ({
        id,
        name,
        sql,
        connectionId,
        connectionLabel,
        readOnly,
        databaseKind,
      }),
    );
    const data = [
      ...savedQueries.current.filter((saved) => !snapshots.some((tab) => tab.id === saved.id)),
      ...snapshots,
    ];
    saving.current = true;
    setSaveBusy(true);
    setStorageError('');
    setStorageMessage('');
    try {
      await queryStore.save(data);
      savedQueries.current = data;
      setTabs((tabs) =>
        tabs.map((tab) => {
          const saved = snapshots.find((saved) => saved.id === tab.id);
          return saved ? { ...tab, savedSql: saved.sql } : tab;
        }),
      );
      setStorageMessage('保存しました');
    } catch (error) {
      setStorageError(`クエリを保存できませんでした: ${String(error)}`);
    } finally {
      saving.current = false;
      setSaveBusy(false);
    }
  }
  const previousConnection = useRef(connectionId);
  useEffect(() => {
    if (!storeLoaded) return;
    if (previousConnection.current === connectionId) return;
    previousConnection.current = connectionId;
    if (connectionId !== 0 && tabs.some((tab) => tab.connectionId === 0)) {
      setTabs((tabs) =>
        tabs.map((tab) =>
          tab.connectionId === 0
            ? {
                ...tab,
                connectionId,
                connectionLabel,
                readOnly,
                databaseKind: mode === 'sqlServer' ? 'sqlServer' : 'mysql',
                sql:
                  tab.sql ||
                  (savedQueries.current.some((saved) => saved.id === tab.id) ? '' : initialSql()),
              }
            : tab,
        ),
      );
      return;
    }
    const existing = tabs.find((tab) => tab.connectionId === connectionId);
    if (existing) setTabId(existing.id);
    else add();
  }, [connectionId, storeLoaded]);
  const [inspectorTab, setInspectorTab] = useState('summary');
  const [history, setHistory] = useState<Execution[]>([]);
  const [exportSelection, setExportSelection] = useState<ExportSelection | null>(null);
  const [closingTabId, setClosingTabId] = useState<number | null>(null);
  const closingTab = tabs.find((tab) => tab.id === closingTabId);
  const current = tabs.find((tab) => tab.id === tabId)!;
  function selectEditor(id: number) {
    if (id === tabId) {
      document.querySelector<HTMLElement>('.sql-code-editor [contenteditable="true"]')?.focus();
      return;
    }
    setTabId(id);
  }
  function closeEditor(id: number, discard = false) {
    const tab = tabs.find((tab) => tab.id === id);
    if (!tab || tab.executionId || saving.current) return;
    if (tab.sql !== tab.savedSql && !discard) {
      setClosingTabId(id);
      return;
    }
    setClosingTabId(null);
    if (tabs.length === 1) {
      const id = nextId.current++;
      setTabs([createTab(id, '')]);
      selectEditor(id);
      return;
    }
    setTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    if (tabId === id) selectEditor(tabs.find((tab) => tab.id !== id)!.id);
  }
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = shortcutTarget(event);
      if (!active || !storeLoaded || !target?.closest('.query-workspace')) return;
      let action: (() => void) | undefined;
      const matches = (id: keyof typeof shortcuts) => matchesShortcut(event, shortcuts[id]);
      if (matches('newQuery')) action = () => add();
      else if (matches('saveQuery')) action = () => void save();
      else if (matches('saveAllQueries')) action = () => void save(true);
      else if (matches('closeQuery')) action = () => closeEditor(tabId);
      else if (matches('nextQuery') || matches('previousQuery'))
        action = () => {
          const index = tabs.findIndex((tab) => tab.id === tabId);
          selectEditor(
            tabs[(index + (matches('previousQuery') ? -1 : 1) + tabs.length) % tabs.length].id,
          );
        };
      else if (matches('run') || matches('runAlternate')) action = () => void run();
      else if (matches('stop')) action = () => void stop();
      else if (
        target.closest('.sql-results') &&
        (matches('previousResult') || matches('nextResult'))
      )
        action = () => {
          if (resultTab !== 'result' || sets.length < 2) return;
          update(tabId, {
            resultIndex:
              (resultIndex + (matches('previousResult') ? -1 : 1) + sets.length) % sets.length,
          });
        };
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
    connectionId !== 0 &&
    !busy &&
    !inFlight.current &&
    current.connectionId === connectionId &&
    !!current.sql.trim();
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
    owner?: Pick<QueryTab, 'connectionId' | 'connectionLabel' | 'readOnly' | 'databaseKind'>,
  ) {
    const id = nextId.current++;
    const tab = createTab(id, sql);
    if (owner) {
      tab.connectionId = owner.connectionId;
      tab.connectionLabel = owner.connectionLabel;
      tab.readOnly = owner.readOnly;
      tab.databaseKind = owner.databaseKind;
    }
    setTabs((tabs) => [...tabs, tab]);
    selectEditor(id);
  }
  async function run(explain = false, confirmed = false) {
    if (explain && mode === 'sqlServer') return;
    if (!canRun || inFlight.current) return;
    if (!explain && !readOnly && !confirmed) {
      setWriteConfirmation({
        id: current.id,
        sql: current.sql,
        connectionId,
        target: connectionTarget ?? connectionLabel,
      });
      return;
    }
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
            databaseKind: current.databaseKind,
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
            databaseKind: current.databaseKind,
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
  if (!storeLoaded) return <p role="status">保存クエリを読み込んでいます…</p>;
  return (
    <div className="query-workspace" style={{ display: 'contents' }}>
      <main className="main-panel sql-main">
        <section className="sql-editor-panel" aria-label="SQLエディタ">
          <div className="sql-toolbar">
            <div
              className="query-tabs"
              role="tablist"
              aria-label="クエリ"
              title={`${shortcutLabel(shortcuts.nextQuery)}: 次のエディタ / ${shortcutLabel(shortcuts.previousQuery)}: 前のエディタ`}
              aria-keyshortcuts={[
                shortcutAria(shortcuts.nextQuery),
                shortcutAria(shortcuts.previousQuery),
              ]
                .filter(Boolean)
                .join(' ')}
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
                  <button
                    aria-label={`${tab.name}を閉じる`}
                    title={`閉じる（${shortcutLabel(shortcuts.closeQuery)}）`}
                    aria-keyshortcuts={shortcutAria(shortcuts.closeQuery)}
                    disabled={!!tab.executionId || saveBusy}
                    onClick={() => closeEditor(tab.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="icon"
                aria-label="新規クエリ"
                title={`新規クエリ（${shortcutLabel(shortcuts.newQuery)}）`}
                aria-keyshortcuts={shortcutAria(shortcuts.newQuery)}
                onClick={() => add()}
              >
                <Plus size={18} />
              </Button>
            </div>
            <div className="query-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={!storeReady || saveBusy}
                title={`保存（${shortcutLabel(shortcuts.saveQuery)}）`}
                aria-keyshortcuts={shortcutAria(shortcuts.saveQuery)}
                onClick={() => void save()}
              >
                <Save size={14} />
                保存
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!storeReady || saveBusy}
                title={`すべて保存（${shortcutLabel(shortcuts.saveAllQueries)}）`}
                aria-keyshortcuts={shortcutAria(shortcuts.saveAllQueries)}
                onClick={() => void save(true)}
              >
                すべて保存
              </Button>
              <Button
                size="sm"
                disabled={!canRun}
                title={`SQL全文を実行（${shortcutLabel(shortcuts.run)} / ${shortcutLabel(shortcuts.runAlternate)}）。選択範囲があっても全文を実行します。`}
                aria-keyshortcuts={[
                  shortcutAria(shortcuts.run),
                  shortcutAria(shortcuts.runAlternate),
                ]
                  .filter(Boolean)
                  .join(' ')}
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
                  title={`このエディタの実行を中断（${shortcutLabel(shortcuts.stop)}）`}
                  aria-keyshortcuts={shortcutAria(shortcuts.stop)}
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
              {current.connectionId === 0
                ? '未接続'
                : current.databaseKind === 'sqlServer'
                  ? 'SQL Server'
                  : 'MySQL'}{' '}
              · {current.readOnly ? '読み取り専用' : '読み書き可能'}
              {current.connectionId !== connectionId &&
                ' · 実行するにはサイドバーでこの接続を選択してください'}
              {busy && !current.executionId && ' · 他の操作が完了するまで実行できません'}
            </span>
            <span>
              Tab で補完 · {shortcutLabel(shortcuts.run)} / {shortcutLabel(shortcuts.runAlternate)}{' '}
              で全文実行（選択範囲に関係なく）
            </span>
          </div>
          {storageError && <p role="alert">{storageError}</p>}
          <SqlEditor
            key={tabId}
            value={current.sql}
            databaseKind={current.databaseKind}
            tables={current.connectionId === connectionId ? tables : []}
            onChange={(sql) => update(tabId, { sql })}
          />
        </section>
        <section
          className="sql-results"
          aria-label="クエリ実行結果"
          tabIndex={0}
          title={`前の結果: ${shortcutLabel(shortcuts.previousResult)} / 次の結果: ${shortcutLabel(shortcuts.nextResult)}`}
          aria-keyshortcuts={[
            shortcutAria(shortcuts.previousResult),
            shortcutAria(shortcuts.nextResult),
          ]
            .filter(Boolean)
            .join(' ')}
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
              <Button
                variant="ghost"
                size="sm"
                disabled={!canRun || mode === 'sqlServer'}
                title={mode === 'sqlServer' ? 'SQL Serverの実行計画は未対応です' : undefined}
                onClick={() => void run(true)}
              >
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
          <div className="query-result-area">
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
                    <Button
                      variant="outline"
                      disabled={!canRun || mode === 'sqlServer'}
                      title={mode === 'sqlServer' ? 'SQL Serverの実行計画は未対応です' : undefined}
                      onClick={() => void run(true)}
                    >
                      実行計画を取得（EXPLAIN）
                    </Button>
                  ) : (
                    'SQLを実行すると、ここに結果が表示されます。'
                  )}
                </div>
              )}
            </div>
            {storageMessage && (
              <div className="query-save-toast" role="status" aria-live="polite">
                <CircleCheck className="query-save-toast-icon" size={18} aria-hidden="true" />
                <span>{storageMessage}</span>
                <button
                  type="button"
                  aria-label="保存通知を閉じる"
                  onClick={() => setStorageMessage('')}
                >
                  <X size={14} aria-hidden="true" />
                </button>
                <div className="query-save-toast-progress" aria-hidden="true" />
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
      <aside
        className="details-panel query-inspector"
        aria-keyshortcuts={shortcutAria(shortcuts.inspector)}
      >
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
      </aside>
      {writeConfirmation && (
        <WriteQueryDialog
          target={writeConfirmation.target}
          sql={writeConfirmation.sql}
          cancel={() => setWriteConfirmation(null)}
          confirm={() => {
            const pending = writeConfirmation;
            setWriteConfirmation(null);
            if (
              pending.id === current.id &&
              pending.sql === current.sql &&
              pending.connectionId === connectionId &&
              pending.target === (connectionTarget ?? connectionLabel)
            )
              void run(false, true);
          }}
        />
      )}
      {closingTab && (
        <CloseQueryDialog
          name={closingTab.name}
          confirm={() => closeEditor(closingTab.id, true)}
          cancel={() => setClosingTabId(null)}
        />
      )}
      {exportSelection && (
        <CsvExportDialog selection={exportSelection} close={() => setExportSelection(null)} />
      )}
    </div>
  );
}
