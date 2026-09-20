import type { SchemaSnapshot } from '@/domain/database';
/** Layer tables by references. Break cycles at the first repeated table deterministically. */
export function layoutTables(snapshot: SchemaSnapshot): Map<string, { x: number; y: number }> {
  const ids = new Set(snapshot.tables.map((table) => table.id));
  const parents = new Map(
    snapshot.tables.map((table) => [
      table.id,
      snapshot.relationships
        .filter(
          (r) => r.sourceTable === table.id && r.targetTable !== table.id && ids.has(r.targetTable),
        )
        .map((r) => r.targetTable),
    ]),
  );
  const depths = new Map<string, number>();
  const depth = (id: string, visiting: Set<string>): number => {
    if (depths.has(id)) return depths.get(id)!;
    if (visiting.has(id)) return 0;
    const path = new Set(visiting).add(id);
    const value = Math.min(
      6,
      Math.max(0, ...(parents.get(id) || []).map((parent) => depth(parent, path) + 1)),
    );
    depths.set(id, value);
    return value;
  };
  for (const table of snapshot.tables) depths.set(table.id, depth(table.id, new Set()));
  const offsets = new Map<number, number>();
  return new Map(
    snapshot.tables.map((table) => {
      const level = depths.get(table.id)!;
      const y = offsets.get(level) || 0;
      offsets.set(level, y + 120 + table.columns.length * 25);
      return [table.id, { x: level * 340 + 40, y: y + 40 }];
    }),
  );
}
