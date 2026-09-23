import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import type { Table } from '@/domain/database';
import { columnsForQualifier, sqlCompletions, typeDiagnostics } from './sql-assistance';

const tables: Table[] = [
  {
    id: 'users',
    schema: 'app',
    name: 'users',
    estimatedRows: 0,
    columns: ['id', 'name', 'full name'].map((name) => ({
      name,
      dataType: 'VARCHAR',
      nullable: false,
      primaryKey: false,
    })),
  },
  {
    id: 'orders',
    schema: 'app',
    name: 'orders',
    estimatedRows: 0,
    columns: ['order_id', 'user_id'].map((name) => ({
      name,
      dataType: 'INT',
      nullable: false,
      primaryKey: false,
    })),
  },
];
function columns(marked: string, qualifier: string) {
  const pos = marked.indexOf('|');
  return columnsForQualifier(marked.replace('|', ''), pos, qualifier, tables);
}
describe('SQL column inference', () => {
  it('resolves aliases declared after the cursor, joins, quoted names and qualified tables', () => {
    expect(
      columns('SELECT u.| FROM app.users AS u JOIN orders o ON u.id = o.user_id', 'u'),
    ).toEqual(['id', 'name', 'full name']);
    expect(columns('SELECT o.| FROM users u, orders o', 'o')).toEqual(['order_id', 'user_id']);
    expect(columns('SELECT `u x`.| FROM `app`.`users` AS `u x`', 'u x')).toContain('name');
  });
  it('infers derived projections, renamed expressions, nested subqueries and stars', () => {
    expect(
      columns(
        'SELECT d.| FROM (SELECT u.id AS user_id, upper(u.name) display_name FROM users u) d',
        'd',
      ),
    ).toEqual(['user_id', 'display_name']);
    expect(
      columns('SELECT d.| FROM (SELECT x.* FROM (SELECT id, name FROM users) x) d', 'd'),
    ).toEqual(['id', 'name']);
    expect(columns('SELECT d.| FROM (SELECT * FROM users) d', 'd')).toEqual([
      'id',
      'name',
      'full name',
    ]);
    expect(columns('SELECT d.| FROM (SELECT count(*) AS total FROM users) d', 'd')).toEqual([
      'total',
    ]);
  });
  it('uses CTE projections including declared column names and chained CTEs', () => {
    expect(
      columns(
        'WITH a AS (SELECT id AS uid FROM users), b AS (SELECT a.* FROM a) SELECT b.| FROM b',
        'b',
      ),
    ).toEqual(['uid']);
    expect(
      columns('WITH a(uid, label) AS (SELECT id, name FROM users) SELECT a.| FROM a', 'a'),
    ).toEqual(['uid', 'label']);
  });
  it('keeps aliases inside their own statement and query scope', () => {
    expect(columns('SELECT u.id FROM users u; SELECT u.| FROM orders o', 'u')).toEqual([]);
    expect(
      columns('SELECT u.id FROM users u WHERE EXISTS (SELECT u.| FROM orders u)', 'u'),
    ).toEqual(['order_id', 'user_id']);
    expect(
      columns('SELECT u.id FROM users u WHERE EXISTS (SELECT u.| FROM orders o)', 'u'),
    ).toContain('name');
    expect(
      columns('SELECT o.| FROM users u WHERE EXISTS (SELECT o.order_id FROM orders o)', 'o'),
    ).toEqual([]);
    expect(columns('SELECT u.id FROM users u UNION SELECT u.| FROM orders o', 'u')).toEqual([]);
  });
  it('uses the first UNION branch to name derived output', () => {
    expect(
      columns(
        'SELECT d.| FROM (SELECT id AS first_id FROM users UNION ALL SELECT order_id FROM orders) d',
        'd',
      ),
    ).toEqual(['first_id']);
  });
  it('handles incomplete subqueries and ignores SQL inside literals/comments', () => {
    expect(columns('SELECT d.| FROM (SELECT id, name FROM users) d -- JOIN orders x', 'd')).toEqual(
      ['id', 'name'],
    );
    expect(columns('SELECT * FROM (SELECT u.| FROM users u', 'u')).toContain('id');
  });
});
describe('completion', () => {
  function complete(marked: string) {
    const pos = marked.indexOf('|');
    return sqlCompletions(tables)(
      new CompletionContext(EditorState.create({ doc: marked.replace('|', '') }), pos, true),
    );
  }
  it('offers MySQL types and SQL keywords', () => {
    const labels = complete('SELECT CAST(id AS VAR|) FROM users')!.options.map((o) => o.label);
    expect(labels).toContain('VARCHAR');
    expect(labels).toContain('SELECT');
    expect(labels).toContain('JSON');
  });
  it('only offers the qualified source columns and quotes special column names', () => {
    const result = complete('SELECT u.| FROM users u')!;
    expect(result.options.map((o) => o.label)).toEqual(['id', 'name', 'full name']);
    expect(result.options.find((o) => o.label === 'full name')!.apply).toBe('`full name`');
    expect(complete('SELECT z.| FROM users u')!.options).toEqual([]);
  });
  it('does not complete inside comments or strings', () => {
    expect(complete("SELECT 'VAR|' FROM users")).toBeNull();
    expect(complete('SELECT 1 -- VAR|')).toBeNull();
    expect(complete('/* SELECT u.| FROM users u */')).toBeNull();
  });
});
describe('type diagnostics', () => {
  function errors(sql: string) {
    return typeDiagnostics(sql).map((d) => sql.slice(d.from, d.to));
  }
  it('underlines misspelled types in casts and table definitions', () => {
    expect(errors('SELECT CAST(id AS INTT), CONVERT(name, VARCAHR(30)) FROM users')).toEqual([
      'INTT',
      'VARCAHR',
    ]);
    expect(
      errors('CREATE TABLE t (id INTT, name VARCAHR(30), amount DECIMAL(10, 2), PRIMARY KEY(id))'),
    ).toEqual(['INTT', 'VARCAHR']);
    expect(
      errors('ALTER TABLE t ADD COLUMN a INTT, MODIFY b VARCAHR(20), CHANGE c d DECIML(4,2)'),
    ).toEqual(['INTT', 'VARCAHR', 'DECIML']);
  });
  it('does not flag valid types, names, comments, strings, or SELECT aliases', () => {
    expect(
      errors("CREATE TABLE t (id INT, name VARCHAR(20), j JSON, y YEAR, p POINT, e ENUM('a','b'))"),
    ).toEqual([]);
    expect(
      errors("SELECT intt AS varcahr, 'CAST(x AS INTT)' FROM users -- CAST(id AS INTT)\n"),
    ).toEqual([]);
    expect(errors('SELECT CAST(id AS SIGNED), CONVERT(name USING utf8mb4) FROM users')).toEqual([]);
    expect(
      errors(
        'ALTER TABLE t ADD INDEX ix (name), ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES users(id)',
      ),
    ).toEqual([]);
    expect(errors('CREATE TABLE t AS SELECT CONCAT(name, id) AS label FROM users')).toEqual([]);
    expect(
      errors(
        'CREATE TEMPORARY TABLE IF NOT EXISTS app.t (a FIXED(10,2), b DEC(10), c NVARCHAR(20))',
      ),
    ).toEqual([]);
  });
});
