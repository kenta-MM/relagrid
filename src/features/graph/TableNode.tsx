import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Table2, KeyRound } from 'lucide-react';
import type { Table } from '@/domain/database';
export type TableGraphNode = Node<
  { table: Table; foreignKeys: string[]; color: string; muted: boolean },
  'table'
>;
export const TableNode = memo(function TableNode({ data, selected }: NodeProps<TableGraphNode>) {
  return (
    <div
      className={`table-node ${selected ? 'is-selected' : ''} ${data.muted ? 'is-muted' : ''}`}
      style={{ '--node-color': data.color } as React.CSSProperties}
    >
      <div className="node-heading">
        <span className="node-icon">
          <Table2 size={20} />
        </span>
        <div>
          <strong>{data.table.name}</strong>
          <small>≈ {data.table.estimatedRows.toLocaleString()} rows</small>
        </div>
      </div>
      <div className="node-columns">
        {data.table.columns.map((column) => (
          <div className="node-column" key={column.name}>
            <Handle type="target" position={Position.Right} id={`in:${column.name}`} />
            <span className="column-name">{column.name}</span>
            {column.primaryKey ? (
              <span className="key-badge">
                <KeyRound size={10} /> PK
              </span>
            ) : data.foreignKeys.includes(column.name) ? (
              <span className="key-badge foreign">FK</span>
            ) : (
              <span className="column-type">{column.dataType.split('(')[0]}</span>
            )}
            <Handle type="source" position={Position.Left} id={`out:${column.name}`} />
          </div>
        ))}
      </div>
    </div>
  );
});
