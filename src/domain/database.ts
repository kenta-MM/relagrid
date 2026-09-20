export interface Column {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
}
export interface Table {
  id: string;
  schema: string;
  name: string;
  estimatedRows: number;
  columns: Column[];
}
export interface Relationship {
  id: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
}
export interface SchemaSnapshot {
  tables: Table[];
  relationships: Relationship[];
}
export interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}
export interface Preview {
  columns: string[];
  rows: (string | null)[][];
}
export interface DatabaseGateway {
  connect(config: ConnectionConfig): Promise<SchemaSnapshot>;
  refresh(): Promise<SchemaSnapshot>;
  preview(table: Table): Promise<Preview>;
  disconnect(): Promise<void>;
}
export function relatedTableIds(snapshot: SchemaSnapshot, tableId: string): Set<string> {
  const result = new Set([tableId]);
  for (const relation of snapshot.relationships) {
    if (relation.sourceTable === tableId) result.add(relation.targetTable);
    if (relation.targetTable === tableId) result.add(relation.sourceTable);
  }
  return result;
}
