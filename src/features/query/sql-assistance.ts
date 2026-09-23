import { MySQL, keywordCompletionSource } from '@codemirror/lang-sql';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Diagnostic } from '@codemirror/lint';
import type { Table } from '@/domain/database';

// Preserve offsets and parentheses even while the statement is incomplete.
interface Token {
  text: string;
  from: number;
  to: number;
  kind: 'word' | 'quoted' | 'string' | 'comment' | 'symbol' | 'group';
  children?: Token[];
}
function tokenize(sql: string): Token[] {
  const root: Token[] = [],
    stack: Token[] = [];
  const pattern =
    /--(?=\s|$)[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:\\.|''|[^'\\])*(?:'|$)|"(?:\\.|""|[^"\\])*(?:"|$)|`(?:``|[^`])*(?:`|$)|[\p{L}\p{N}_$]+|[^\s]/gu;
  for (const match of sql.matchAll(pattern)) {
    const text = match[0],
      from = match.index!;
    if (text === ')' && stack.length) {
      stack.pop()!.to = from + 1;
      continue;
    }
    const token: Token = {
      text,
      from,
      to: from + text.length,
      kind: /^(--|#|\/\*)/.test(text)
        ? 'comment'
        : /^["']/.test(text)
          ? 'string'
          : text[0] === '`'
            ? 'quoted'
            : /^[\p{L}\p{N}_$]/u.test(text)
              ? 'word'
              : 'symbol',
    };
    (stack.at(-1)?.children ?? root).push(token);
    if (text === '(') {
      token.kind = 'group';
      token.children = [];
      token.to = sql.length;
      stack.push(token);
    }
  }
  return root;
}
const key = (token?: Token) => (token?.kind === 'word' ? token.text.toUpperCase() : '');
const name = (token: Token) =>
  token.kind === 'quoted' ? token.text.slice(1, -1).replaceAll('``', '`') : token.text;
const identifier = (token?: Token): token is Token =>
  !!token && ['word', 'quoted'].includes(token.kind);
const clean = (tokens: Token[]) => tokens.filter((t) => t.kind !== 'comment');
const reserved = new Set((MySQL.spec.keywords ?? '').toUpperCase().split(/\s+/));
const isAlias = (token?: Token): token is Token =>
  identifier(token) && (token.kind === 'quoted' || !reserved.has(key(token)));
const split = (tokens: Token[], separator: string) => {
  const parts: Token[][] = [[]];
  for (const token of tokens) {
    if (token.text === separator) parts.push([]);
    else parts.at(-1)!.push(token);
  }
  return parts;
};
type Sources = Map<string, string[]>;
interface Scope {
  from: number;
  to: number;
  sources: Sources;
}

function analyze(sql: string, tables: Table[]) {
  const scopes: Scope[] = [];
  const catalog: Sources = new Map();
  for (const table of tables) {
    const columns = table.columns.map((c) => c.name);
    catalog.set(table.name.toLowerCase(), columns);
    catalog.set(`${table.schema}.${table.name}`.toLowerCase(), columns);
  }
  function query(
    input: Token[],
    from: number,
    to: number,
    ctes: Sources,
    outer: Sources,
    depth = 0,
  ): string[] {
    if (depth > 40) return [];
    const tokens = clean(input);
    const localCtes = new Map(ctes);
    let start = 0;
    if (key(tokens[0]) === 'WITH') {
      start = key(tokens[1]) === 'RECURSIVE' ? 2 : 1;
      while (identifier(tokens[start])) {
        const cte = name(tokens[start++]).toLowerCase();
        const columns =
          tokens[start]?.kind === 'group'
            ? clean(tokens[start++].children!).filter(identifier).map(name)
            : undefined;
        if (key(tokens[start]) !== 'AS' || tokens[start + 1]?.kind !== 'group') break;
        const body = tokens[start + 1];
        if (columns) localCtes.set(cte, columns);
        const projected = query(
          body.children!,
          body.from + 1,
          body.to - 1,
          localCtes,
          new Map(),
          depth + 1,
        );
        localCtes.set(cte, columns ?? projected);
        start += 2;
        if (tokens[start]?.text !== ',') break;
        start++;
      }
    }
    // Each UNION branch has its own aliases. The first branch names the result.
    const union = tokens.findIndex(
      (t, i) => i >= start && ['UNION', 'INTERSECT', 'EXCEPT'].includes(key(t)),
    );
    if (union >= 0) {
      const first = query(
        tokens.slice(start, union),
        from,
        tokens[union].from,
        localCtes,
        outer,
        depth + 1,
      );
      query(tokens.slice(union + 1), tokens[union].to, to, localCtes, outer, depth + 1);
      return first;
    }
    const sources: Sources = new Map();
    const visited = new Set<Token>();
    let inFrom = false;
    for (let i = start; i < tokens.length; i++) {
      const word = key(tokens[i]);
      if (['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'SET', 'VALUES'].includes(word))
        inFrom = false;
      const sourceStart =
        ['FROM', 'JOIN', 'STRAIGHT_JOIN', 'UPDATE'].includes(word) ||
        (inFrom && tokens[i].text === ',');
      if (!sourceStart) continue;
      inFrom = true;
      let j = i + 1;
      if (key(tokens[j]) === 'LATERAL') j++;
      const source = tokens[j];
      if (!source) continue;
      let columns: string[] = [],
        sourceName = '';
      if (source.kind === 'group') {
        visited.add(source);
        columns = query(
          source.children!,
          source.from + 1,
          source.to - 1,
          localCtes,
          new Map([...outer, ...sources]),
          depth + 1,
        );
        j++;
      } else if (identifier(source)) {
        sourceName = name(source);
        j++;
        if (tokens[j]?.text === '.' && identifier(tokens[j + 1])) {
          sourceName += '.' + name(tokens[j + 1]);
          j += 2;
        }
        columns =
          localCtes.get(sourceName.toLowerCase()) ?? catalog.get(sourceName.toLowerCase()) ?? [];
      } else continue;
      if (key(tokens[j]) === 'AS') j++;
      if (isAlias(tokens[j])) sources.set(name(tokens[j]).toLowerCase(), columns);
      else if (sourceName) {
        sources.set(sourceName.toLowerCase(), columns);
        if (sourceName.includes('.'))
          sources.set(sourceName.split('.').at(-1)!.toLowerCase(), columns);
      }
      i = j - 1;
    }
    const visible = new Map([...outer, ...sources]);
    scopes.push({ from, to, sources: visible });
    function nested(items: Token[]) {
      for (const token of items) {
        if (!token.children || visited.has(token)) continue;
        const child = clean(token.children);
        if (child.some((t) => ['SELECT', 'WITH'].includes(key(t))))
          query(child, token.from + 1, token.to - 1, localCtes, visible, depth + 1);
        else nested(child);
      }
    }
    nested(tokens.slice(start));
    const select = tokens.findIndex((t, i) => i >= start && key(t) === 'SELECT');
    if (select < 0) return [];
    let end = tokens.findIndex((t, i) => i > select && ['FROM', 'INTO'].includes(key(t)));
    if (end < 0) end = tokens.length;
    const projection = tokens.slice(select + 1, end);
    while (['DISTINCT', 'ALL', 'DISTINCTROW', 'SQL_CALC_FOUND_ROWS'].includes(key(projection[0])))
      projection.shift();
    return split(projection, ',').flatMap((part) => {
      if (!part.length) return [];
      const as = part.findIndex((t) => key(t) === 'AS');
      if (as >= 0 && identifier(part[as + 1])) return [name(part[as + 1])];
      const last = part.at(-1)!;
      if (
        part.length > 1 &&
        isAlias(last) &&
        (part.at(-2)!.kind === 'group' ||
          (part.at(-2)!.to < last.from &&
            part.at(-2)!.text !== '.' &&
            part.at(-2)!.kind !== 'symbol'))
      )
        return [name(last)];
      if (part.length === 1 && last.text === '*') return [...new Set([...sources.values()].flat())];
      if (part.length === 3 && part[1].text === '.' && last.text === '*')
        return sources.get(name(part[0]).toLowerCase()) ?? [];
      if ((part.length === 1 || (part.length === 3 && part[1].text === '.')) && identifier(last))
        return [name(last)];
      return [sql.slice(part[0].from, last.to)];
    });
  }
  for (const statement of split(tokenize(sql), ';')) {
    if (statement.length)
      query(statement, statement[0].from, statement.at(-1)!.to, new Map(), new Map());
  }
  return scopes;
}

export function columnsForQualifier(
  sql: string,
  pos: number,
  qualifier: string,
  tables: Table[],
): string[] {
  const scopes = analyze(sql, tables)
    .filter((s) => s.from <= pos && s.to >= pos)
    .sort((a, b) => a.to - a.from - (b.to - b.from));
  return scopes[0]?.sources.get(qualifier.toLowerCase()) ?? [];
}

const extraTypes =
  'JSON YEAR ENUM SET SERIAL BOOL BOOLEAN DEC FIXED MIDDLEINT NVARCHAR GEOMETRY POINT LINESTRING POLYGON MULTIPOINT MULTILINESTRING MULTIPOLYGON GEOMETRYCOLLECTION';
export const builtinTypes = [
  ...new Set(`${MySQL.spec.types} ${extraTypes}`.toUpperCase().split(/\s+/).filter(Boolean)),
];
const keywords = keywordCompletionSource(MySQL, true);
export function sqlCompletions(tables: Table[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const text = context.state.doc.toString();
    // Do not offer code inside comments or string literals.
    function excluded(tokens: Token[]): boolean {
      return tokens.some(
        (t) =>
          t.from < context.pos &&
          t.to >= context.pos &&
          (['comment', 'string'].includes(t.kind) || (t.children && excluded(t.children))),
      );
    }
    if (excluded(tokenize(text))) return null;
    const prefix = text.slice(0, context.pos);
    const qualified = /(`(?:``|[^`])+`|[\p{L}\p{N}_$]+)\.(`(?:``|[^`])*|[\p{L}\p{N}_$]*)$/u.exec(
      prefix,
    );
    if (qualified) {
      const quoted = qualified[2].startsWith('`');
      const qualifier = qualified[1].replace(/^`|`$/g, '').replaceAll('``', '`');
      const from = context.pos - qualified[2].length;
      return {
        from,
        to: quoted && text[context.pos] === '`' ? context.pos + 1 : context.pos,
        options: columnsForQualifier(text, context.pos, qualifier, tables).map((label) => ({
          label,
          type: 'property',
          detail: qualifier,
          apply:
            quoted ||
            !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(label) ||
            reserved.has(label.toUpperCase())
              ? '`' + label.replaceAll('`', '``') + '`'
              : label,
        })),
      };
    }
    const word = context.matchBefore(/[\p{L}\p{N}_$]+/u);
    if (!word && !context.explicit) return null;
    const result = keywords(context) as CompletionResult | null;
    const options = [
      ...builtinTypes.map((label) => ({ label, type: 'type', detail: 'MySQL 型' })),
      ...(result?.options ?? []),
      ...tables.map((t) => ({
        label: t.name,
        type: 'class',
        detail: 'テーブル',
        apply: '`' + t.name.replaceAll('`', '``') + '`',
      })),
    ];
    return {
      from: word?.from ?? context.pos,
      options: options.filter(
        (option, i) => options.findIndex((o) => o.label === option.label) === i,
      ),
    };
  };
}

export function typeDiagnostics(sql: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  function check(token?: Token) {
    if (!identifier(token) || builtinTypes.includes(key(token))) return;
    diagnostics.push({
      from: token.from,
      to: token.to,
      severity: 'error',
      message: `「${name(token)}」はMySQLの組み込み型ではありません。型名を確認してください。`,
    });
  }
  function visit(input: Token[]) {
    const tokens = clean(input);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (['CAST', 'CONVERT'].includes(key(token)) && tokens[i + 1]?.children) {
        const args = clean(tokens[i + 1].children!);
        const as = args.findIndex(
          (t) => key(t) === 'AS' || (key(token) === 'CONVERT' && t.text === ','),
        );
        if (as >= 0) check(args[as + 1]);
      }
      if (token.children) visit(token.children);
    }
  }
  const statements = split(tokenize(sql), ';');
  for (const statement of statements) {
    const tokens = clean(statement);
    visit(tokens);
    if (key(tokens[0]) === 'CREATE' && ['TABLE', 'TEMPORARY'].includes(key(tokens[1]))) {
      let tableName = key(tokens[1]) === 'TEMPORARY' ? 3 : 2;
      if (key(tokens[tableName]) === 'IF') tableName += 3;
      let bodyIndex = tableName + 1;
      if (tokens[bodyIndex]?.text === '.') bodyIndex += 2;
      const body = tokens[bodyIndex]?.kind === 'group' ? tokens[bodyIndex] : undefined;
      for (const column of split(clean(body?.children ?? []), ',')) {
        if (
          identifier(column[0]) &&
          ![
            'PRIMARY',
            'FOREIGN',
            'UNIQUE',
            'CONSTRAINT',
            'KEY',
            'INDEX',
            'CHECK',
            'FULLTEXT',
            'SPATIAL',
          ].includes(key(column[0]))
        )
          check(column[1]);
      }
    }
    if (key(tokens[0]) === 'ALTER' && key(tokens[1]) === 'TABLE') {
      for (let i = 0; i < tokens.length; i++) {
        const op = key(tokens[i]);
        if (!['ADD', 'MODIFY', 'CHANGE'].includes(op)) continue;
        let j = i + 1;
        if (key(tokens[j]) === 'COLUMN') j++;
        if (
          [
            'CONSTRAINT',
            'INDEX',
            'KEY',
            'PRIMARY',
            'FOREIGN',
            'UNIQUE',
            'CHECK',
            'PARTITION',
            'FULLTEXT',
            'SPATIAL',
          ].includes(key(tokens[j]))
        )
          continue;
        if (tokens[j]?.children && op === 'ADD') {
          for (const column of split(clean(tokens[j].children!), ',')) check(column[1]);
        } else check(tokens[j + (op === 'CHANGE' ? 2 : 1)]);
      }
    }
  }
  return diagnostics;
}
