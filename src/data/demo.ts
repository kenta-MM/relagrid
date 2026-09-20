import type { DatabaseGateway, Table, SchemaSnapshot } from '@/domain/database';
const table = (name: string, estimatedRows: number, fields: string[]): Table => ({
  id: `sales.${name}`,
  schema: 'sales',
  name,
  estimatedRows,
  columns: fields.map((field, index) => {
    const [name, dataType] = field.split(':');
    return { name, dataType: dataType || 'bigint', nullable: false, primaryKey: index === 0 };
  }),
});
export const demoSnapshot: SchemaSnapshot = {
  tables: [
    table('Customer', 7482, [
      'customer_id',
      'name:varchar(100)',
      'email:varchar(255)',
      'phone:varchar(30)',
      'created_at:datetime',
    ]),
    table('Order', 24893, [
      'order_id',
      'customer_id',
      'order_date:datetime',
      'status:varchar(20)',
      'total_amount:decimal(12,2)',
    ]),
    table('Payment', 24761, [
      'payment_id',
      'order_id',
      'payment_method:varchar(30)',
      'amount:decimal(12,2)',
      'paid_at:datetime',
    ]),
    table('OrderDetail', 120421, [
      'order_detail_id',
      'order_id',
      'product_id',
      'quantity:int',
      'unit_price:decimal(12,2)',
    ]),
    table('Product', 3982, [
      'product_id',
      'name:varchar(100)',
      'category_id',
      'unit_price:decimal(12,2)',
      'status:varchar(20)',
    ]),
    table('Shipment', 23980, [
      'shipment_id',
      'order_id',
      'shipping_no:varchar(50)',
      'shipped_at:datetime',
      'delivered_at:datetime',
    ]),
    table('Inventory', 3982, ['inventory_id', 'product_id', 'quantity:int', 'updated_at:datetime']),
  ],
  relationships: [
    ['Order', 'customer_id', 'Customer', 'customer_id'],
    ['Payment', 'order_id', 'Order', 'order_id'],
    ['OrderDetail', 'order_id', 'Order', 'order_id'],
    ['OrderDetail', 'product_id', 'Product', 'product_id'],
    ['Shipment', 'order_id', 'Order', 'order_id'],
    ['Inventory', 'product_id', 'Product', 'product_id'],
  ].map(([source, sourceColumn, target, targetColumn], index) => ({
    id: `fk_${index}`,
    sourceTable: `sales.${source}`,
    sourceColumn,
    targetTable: `sales.${target}`,
    targetColumn,
  })),
};
export const demoGateway: DatabaseGateway = {
  async connect() {
    return demoSnapshot;
  },
  async refresh() {
    return demoSnapshot;
  },
  async disconnect() {},
  async preview(table) {
    return {
      columns: table.columns.map((c) => c.name),
      rows: Array.from({ length: 8 }, (_, row) =>
        table.columns.map((column) => {
          if (column.name.endsWith('_id')) return String(1052 + row);
          if (column.dataType === 'datetime')
            return `2026-09-${String(12 + row).padStart(2, '0')} 10:24:00`;
          if (column.name === 'status') return ['completed', 'processing', 'pending'][row % 3];
          if (column.name === 'name') return ['Aoki', 'Tanaka', 'Suzuki', 'Sato'][row % 4];
          if (column.name === 'email') return `customer${row + 1}@example.com`;
          if (column.dataType.startsWith('decimal')) return String(2400 + row * 1200);
          if (column.name === 'quantity') return String(row + 1);
          return `sample-${row + 1}`;
        }),
      ),
    };
  },
};
