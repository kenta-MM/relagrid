import { useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
  MarkerType,
} from '@xyflow/react';
import { Maximize, LayoutGrid } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { relatedTableIds, type SchemaSnapshot } from '@/domain/database';
import { TableNode, type TableGraphNode } from './TableNode';
import { layoutTables } from './schema-layout';
const nodeTypes = { table: TableNode };
const colors = ['#54bce8', '#9b79ff', '#a38af2', '#32c7c4', '#d5ad64', '#e8b75f', '#72a4e9'];
interface Props {
  snapshot: SchemaSnapshot;
  selected: string;
  relatedOnly: boolean;
  onSelect(id: string): void;
}
function Graph({ snapshot, selected, relatedOnly, onSelect }: Props) {
  const positions = useMemo(() => layoutTables(snapshot), [snapshot]);
  const [nodes, setNodes, onNodesChange] = useNodesState<TableGraphNode>([]);
  const { fitView } = useReactFlow();
  useEffect(() => {
    setNodes(
      snapshot.tables.map((table, index) => ({
        id: table.id,
        type: 'table',
        position: positions.get(table.id)!,
        data: {
          table,
          foreignKeys: snapshot.relationships
            .filter((r) => r.sourceTable === table.id)
            .map((r) => r.sourceColumn),
          color: colors[index % colors.length],
          muted: false,
        },
      })),
    );
    const timer = setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 100);
    return () => clearTimeout(timer);
  }, [snapshot, positions, setNodes, fitView]);
  const related = useMemo(() => relatedTableIds(snapshot, selected), [snapshot, selected]);
  const displayedNodes = nodes.map((node) => ({
    ...node,
    selected: node.id === selected,
    data: { ...node.data, muted: relatedOnly && !related.has(node.id) },
  }));
  const edges = snapshot.relationships.map((relation) => ({
    id: relation.id,
    source: relation.sourceTable,
    target: relation.targetTable,
    sourceHandle: `out:${relation.sourceColumn}`,
    targetHandle: `in:${relation.targetColumn}`,
    label: 'FK',
    type: 'smoothstep',
    style: {
      stroke:
        relation.sourceTable === selected || relation.targetTable === selected
          ? '#a58af9'
          : '#466779',
      strokeWidth: 1.7,
      opacity:
        relatedOnly && relation.sourceTable !== selected && relation.targetTable !== selected
          ? 0.15
          : 1,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#9d88d9' },
    labelStyle: { fill: '#a8b5cd', fontSize: 11 },
    labelBgStyle: { fill: '#0c111b' },
  }));
  return (
    <ReactFlow
      nodes={displayedNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onSelect(node.id)}
      nodesConnectable={false}
      edgesReconnectable={false}
      deleteKeyCode={null}
      minZoom={0.15}
      maxZoom={1.8}
      fitView
      colorMode="dark"
    >
      <Background color="#293448" gap={22} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        style={{ width: 122, height: 80 }}
        nodeColor={(node) => (node.data as TableGraphNode['data']).color}
        maskColor="rgba(10,14,23,.8)"
        pannable
        zoomable
      />
      <Panel position="top-right" className="graph-toolbar">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setNodes((current) =>
              current.map((node) => ({ ...node, position: positions.get(node.id)! })),
            );
            setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 50);
          }}
        >
          <LayoutGrid size={14} />
          自動配置
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fitView({ padding: 0.15, duration: 300 })}
        >
          <Maximize size={14} />
          全体表示
        </Button>
      </Panel>
      {!nodes.length && <Panel position="top-center">表示できるテーブルがありません。</Panel>}
    </ReactFlow>
  );
}
export function SchemaGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
