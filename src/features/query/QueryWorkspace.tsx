import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Download, Play, Plus, Save, Table2, X, Clock, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { QueryResult, Table } from '@/domain/database';
import { SqlEditor } from './SqlEditor';

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
  page: number;
  size: number;
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
  navigation: ReactNode;
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
function ResultTable({ result, page, size }: { result: QueryResult; page: number; size: number }) {
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
          {result.columns.length ? '結果は0件です' : `${result.affectedRows} 行に影響しました`}
        </caption>
      )}
    </table>
  );
}
export function QueryWorkspace({
  active,
  navigation,
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
      page: 0,
      size: 10,
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
  const current = tabs.find((tab) => tab.id === tabId)!;
  const { resultTab, page, size } = current;
  function setSize(size: number) {
    update(tabId, { size });
  }
  const canRun =
    !busy && !inFlight.current && current.connectionId === connectionId && !!current.sql.trim();
  function setResultTab(resultTab: string) {
    update(tabId, { resultTab });
  }
  function setPage(page: number) {
    update(tabId, { page });
  }
  const result = resultTab === 'plan' ? current.plan : current.result;
  const latest = history.find(
    (item) =>
      item.tabId === tabId && (resultTab === 'messages' || item.explain === (resultTab === 'plan')),
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
    setTabId(id);
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
      page: 0,
      error: undefined,
      ...(explain ? { plan: undefined } : { result: undefined }),
    });
    try {
      const result = await execute(sql, explain, executionId);
      update(id, { [explain ? 'plan' : 'result']: result, lastSql: sql });
      setHistory((items) =>
        [
          {
            id: executionId,
            tabId: id,
            sql,
            time: new Date().toLocaleTimeString('ja-JP'),
            result,
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
      update(id, { error: message, resultTab: 'messages', page: 0 });
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
    const cell = (value: string | null) => {
      let text = value ?? '';
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    download(
      `${current.name}.csv`,
      '\uFEFF' +
        [result.columns, ...result.rows].map((row) => row.map(cell).join(',')).join('\r\n'),
      'text/csv;charset=utf-8',
    );
  }
  if (!active) return null;
  return (
    <div className="query-workspace" style={{ display: 'contents' }}>
      <main className="main-panel sql-main">
        <div className="map-heading">
          <div>
            <div className="eyebrow">
              <Database size={13} /> DATABASE EXPLORER
            </div>
            <h2>SQLエディタ</h2>
            <p>データの探索・分析・抽出を、より自由に</p>
          </div>
          {navigation}
        </div>
        <section className="sql-editor-panel" aria-label="SQLエディタ">
          <div className="sql-toolbar">
            <div className="query-tabs" role="tablist" aria-label="クエリ">
              {tabs.map((tab) => (
                <div className={`query-tab ${tab.id === tabId ? 'active' : ''}`} key={tab.id}>
                  <button
                    role="tab"
                    aria-label={tab.name}
                    title={`${tab.connectionLabel}${tab.sql !== tab.savedSql ? ' · 未保存' : ''}`}
                    aria-selected={tab.id === tabId}
                    onClick={() => {
                      setTabId(tab.id);
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
                      disabled={!!tab.executionId}
                      onClick={() => {
                        if (
                          tab.executionId ||
                          (tab.sql !== tab.savedSql &&
                            !window.confirm(`${tab.name}の未保存SQLを破棄しますか？`))
                        )
                          return;
                        setTabs((tabs) => tabs.filter((t) => t.id !== tab.id));
                        if (tabId === tab.id) setTabId(tabs.find((t) => t.id !== tab.id)!.id);
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))}
              <Button variant="ghost" size="icon" aria-label="新規クエリ" onClick={() => add()}>
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
              <Button size="sm" disabled={!canRun} onClick={() => void run()}>
                <Play size={14} />
                {current.executionId ? '実行中…' : '実行'}
              </Button>
              {current.executionId && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={current.cancelling}
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
            <span>Tab で補完 · Ctrl / ⌘ + Space で候補 · Ctrl / ⌘ + Enter で実行</span>
          </div>
          <SqlEditor
            key={tabId}
            value={current.sql}
            tables={current.connectionId === connectionId ? tables : []}
            onChange={(sql) => update(tabId, { sql })}
            onRun={() => void run()}
          />
          {compare && current.lastSql && (
            <div className="query-comparison">
              <span>前回実行したSQL</span>
              <pre>{current.lastSql}</pre>
            </div>
          )}
        </section>
        <section className="sql-results" aria-label="クエリ実行結果">
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
                    setPage(0);
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
            <Button variant="ghost" size="sm" disabled={!result} onClick={exportCsv}>
              <Download size={14} />
              エクスポート
            </Button>
          </div>
          <div className="query-result-scroll">
            {resultTab === 'messages' ? (
              <div className="query-message" role={current.error ? 'alert' : 'status'}>
                {current.error ||
                  (latest?.result
                    ? `${latest.explain ? '実行計画を取得' : '実行完了'} · ${latest.result.elapsedMs} ms · ${latest.result.rows.length} 行取得 · ${latest.result.affectedRows} 行に影響`
                    : 'SQLを入力して実行してください。')}
                {latest?.result?.truncated && (
                  <p>結果は上限（1,000行・各値5,000文字・合計約5MB）で省略されています。</p>
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
                ? `${result.rows.length} 行 · ${result.elapsedMs} ms${result.truncated ? '（上限で省略）' : ''}`
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
      <aside className="details-panel query-inspector">
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
              <dd>{latest?.result ? `${latest.result.rows.length} 行` : '—'}</dd>
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
              <span>{item.explain ? 'EXPLAIN' : `${item.result?.rows.length ?? 0} 行`}</span>
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
    </div>
  );
}
