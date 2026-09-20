import { describe, expect, it } from 'vitest';
import { layoutTables } from './schema-layout';
import { relatedTableIds, type SchemaSnapshot } from '@/domain/database';
import { demoSnapshot } from '@/data/demo';
describe('schema graph', () => {
  it('places all tables once without overlaps within a layer', () => {
    const positions = layoutTables(demoSnapshot);
    expect(positions.size).toBe(demoSnapshot.tables.length);
    expect(new Set([...positions.values()].map((p) => `${p.x}:${p.y}`)).size).toBe(positions.size);
    expect(positions.get('sales.Order')!.x).toBeGreaterThan(positions.get('sales.Customer')!.x);
  });
  it('handles cycles, self references, and missing targets', () => {
    const snapshot: SchemaSnapshot = {
      tables: demoSnapshot.tables.slice(0, 2),
      relationships: [
        {
          id: 'a',
          sourceTable: 'sales.Order',
          targetTable: 'sales.Customer',
          sourceColumn: 'customer_id',
          targetColumn: 'customer_id',
        },
        {
          id: 'b',
          sourceTable: 'sales.Customer',
          targetTable: 'sales.Order',
          sourceColumn: 'customer_id',
          targetColumn: 'order_id',
        },
        {
          id: 'c',
          sourceTable: 'sales.Order',
          targetTable: 'missing',
          sourceColumn: 'order_id',
          targetColumn: 'id',
        },
        {
          id: 'd',
          sourceTable: 'sales.Customer',
          targetTable: 'sales.Customer',
          sourceColumn: 'customer_id',
          targetColumn: 'customer_id',
        },
      ],
    };
    const positions = layoutTables(snapshot);
    expect([...positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(
      true,
    );
    expect(layoutTables({ tables: [], relationships: [] }).size).toBe(0);
  });
  it('highlights incoming and outgoing neighbors without transitive expansion', () => {
    const ids = relatedTableIds(demoSnapshot, 'sales.Order');
    expect([...ids].sort()).toEqual([
      'sales.Customer',
      'sales.Order',
      'sales.OrderDetail',
      'sales.Payment',
      'sales.Shipment',
    ]);
    expect(ids.has('sales.Product')).toBe(false);
  });
});
