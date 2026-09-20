import { ArrowDownLeft, ArrowUpRight, KeyRound, Table2, Network, Rows3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { SchemaSnapshot, Table } from '@/domain/database';
interface Props {
  table?: Table;
  snapshot: SchemaSnapshot;
  relatedOnly: boolean;
  busy: boolean;
  onSelect(id: string): void;
  onBrowse(): void;
  onToggleRelated(): void;
}
export function TableDetails({
  table,
  snapshot,
  relatedOnly,
  busy,
  onSelect,
  onBrowse,
  onToggleRelated,
}: Props) {
  if (!table)
    return (
      <aside className="details-panel">
        <h2>テーブル詳細</h2>
        <p className="muted">テーブルを選択してください。</p>
      </aside>
    );
  const outgoing = snapshot.relationships.filter((r) => r.sourceTable === table.id);
  const incoming = snapshot.relationships.filter((r) => r.targetTable === table.id);
  const relations = (direction: 'out' | 'in') =>
    (direction === 'out' ? outgoing : incoming).map((relation) => {
      const id = direction === 'out' ? relation.targetTable : relation.sourceTable;
      return (
        <button className="relation-item" key={relation.id} onClick={() => onSelect(id)}>
          <Table2 size={16} />
          <span>
            {snapshot.tables.find((t) => t.id === id)?.name || id}
            <small>
              {direction === 'out' ? relation.sourceColumn : relation.targetColumn} →{' '}
              {direction === 'out' ? relation.targetColumn : relation.sourceColumn}
            </small>
          </span>
          <ArrowUpRight size={13} />
        </button>
      );
    });
  return (
    <aside className="details-panel">
      <div className="details-title">
        <h2>テーブル詳細</h2>
        <span className="tiny-label">INSPECTOR</span>
      </div>
      <div className="selected-table">
        <span className="detail-icon">
          <Table2 size={25} />
        </span>
        <div>
          <h3>{table.name}</h3>
          <p>
            {table.schema}.{table.name}
          </p>
        </div>
        <span className="selected-label">選択中</span>
      </div>
      <Tabs defaultValue="overview" key={table.id}>
        <TabsList>
          <TabsTrigger value="overview">概要</TabsTrigger>
          <TabsTrigger value="columns">
            カラム <span className="tab-count">{table.columns.length}</span>
          </TabsTrigger>
          <TabsTrigger value="relations">依存関係</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <section className="detail-section">
            <h4>
              <Rows3 size={14} />
              基本情報
            </h4>
            <dl>
              <dt>行数（推定）</dt>
              <dd>{table.estimatedRows.toLocaleString()}</dd>
              <dt>カラム数</dt>
              <dd>{table.columns.length}</dd>
              <dt>スキーマ</dt>
              <dd>{table.schema}</dd>
            </dl>
          </section>
          <section className="detail-section">
            <h4>
              <KeyRound size={14} />
              Primary Key
            </h4>
            {table.columns
              .filter((c) => c.primaryKey)
              .map((c) => (
                <div className="primary-key" key={c.name}>
                  <KeyRound size={16} />
                  {c.name}
                </div>
              ))}
            {!table.columns.some((c) => c.primaryKey) && <p className="muted">主キーなし</p>}
          </section>
          <section className="detail-section">
            <h4>
              <ArrowUpRight size={15} />
              参照先 <span>{outgoing.length}</span>
            </h4>
            {relations('out')}
            {!outgoing.length && <p className="muted">参照先なし</p>}
          </section>
          <section className="detail-section">
            <h4>
              <ArrowDownLeft size={15} />
              参照元 <span>{incoming.length}</span>
            </h4>
            {relations('in')}
            {!incoming.length && <p className="muted">参照元なし</p>}
          </section>
        </TabsContent>
        <TabsContent value="columns">
          <div className="column-details">
            {table.columns.map((column) => (
              <div key={column.name}>
                <strong>
                  {column.name}
                  {column.primaryKey && <KeyRound size={12} />}
                </strong>
                <span>{column.dataType}</span>
                <small>{column.nullable ? 'NULL許可' : 'NOT NULL'}</small>
              </div>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="relations">
          <section className="detail-section">
            <h4>参照先</h4>
            {outgoing.length ? relations('out') : <p className="muted">参照先なし</p>}
          </section>
          <section className="detail-section">
            <h4>参照元</h4>
            {incoming.length ? relations('in') : <p className="muted">参照元なし</p>}
          </section>
          <p className="muted">外部キー制約に基づく関係です。線は参照元から参照先を示します。</p>
        </TabsContent>
      </Tabs>
      <div className="detail-actions">
        <Button onClick={onBrowse} disabled={busy}>
          <Table2 size={16} />
          データを表示
        </Button>
        <Button variant="outline" onClick={onToggleRelated} aria-pressed={relatedOnly}>
          <Network size={16} />
          {relatedOnly ? 'すべての関係を表示' : '関連テーブルを強調'}
        </Button>
        <p>データの変更・削除は行いません</p>
      </div>
    </aside>
  );
}
