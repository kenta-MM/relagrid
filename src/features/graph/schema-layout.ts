import type { SchemaSnapshot } from '@/domain/database';
/** Layer tables by references. Break cycles at the first repeated table deterministically. */
export function layoutTables(snapshot: SchemaSnapshot): Map<string, { x: number; y: number }> {
  const parents = new Map<string, string[]>(snapshot.tables.map((table) => [table.id, []]));
  for (const relation of snapshot.relationships) {
    if (relation.sourceTable !== relation.targetTable && parents.has(relation.targetTable)) {
      parents.get(relation.sourceTable)?.push(relation.targetTable);
    }
  }
  const depths = new Map<string, number>();
  // Explicit DFS frames avoid call-stack overflow and copying the whole path per edge.
  // Preserve traversal order, cycle handling, and the existing six-layer depth cap.
  for (const table of snapshot.tables) {
    if (depths.has(table.id)) continue;
    const visiting = new Set([table.id]);
    const stack = [{ id: table.id, nextParent: 0, depth: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const references = parents.get(frame.id)!;
      if (frame.nextParent < references.length) {
        const parent = references[frame.nextParent];
        const knownDepth = depths.get(parent);
        if (knownDepth === undefined && !visiting.has(parent)) {
          visiting.add(parent);
          stack.push({ id: parent, nextParent: 0, depth: 0 });
          continue;
        }
        frame.depth = Math.min(6, Math.max(frame.depth, (knownDepth ?? 0) + 1));
        frame.nextParent++;
      } else {
        depths.set(frame.id, frame.depth);
        visiting.delete(frame.id);
        stack.pop();
      }
    }
  }
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
