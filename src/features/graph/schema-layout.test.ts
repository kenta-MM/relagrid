import { describe, expect, it } from 'vitest';
import { layoutTables } from './schema-layout';
import { relatedTableIds, type SchemaSnapshot } from '@/domain/database';
import { demoSnapshot } from '../../../tests/fixtures/demo';
describe('schema graph', () => {
  it('lays out a deep reference chain without overflowing the call stack', () => {
    const count = 15000;
    const snapshot: SchemaSnapshot = {
      tables: Array.from({ length: count }, (_, index) => ({
        ...demoSnapshot.tables[0],
        id: String(index),
        columns: [],
      })),
      relationships: Array.from({ length: count - 1 }, (_, index) => ({
        id: String(index),
        sourceTable: String(index),
        targetTable: String(index + 1),
        sourceColumn: 'id',
        targetColumn: 'id',
      })),
    };
    const positions = layoutTables(snapshot);
    expect(positions.size).toBe(count);
    expect(positions.get(String(count - 1))).toEqual({ x: 40, y: 40 });
    expect(positions.get(String(count - 2))!.x).toBe(380);
    expect(positions.get('0')!.x).toBe(2080);
    expect(new Set([...positions.values()].map((p) => `${p.x}:${p.y}`)).size).toBe(count);
  });

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
